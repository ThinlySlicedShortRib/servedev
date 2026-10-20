import AppKit
import Foundation

enum Connection: Equatable {
  case connecting
  case connected
  case offline(String)
}

/** What the menu shows: the daemon's servers and profiles, kept current by its event stream. */
@MainActor
final class Store: ObservableObject {
  @Published private(set) var servers: [String: Server] = [:]
  @Published private(set) var profiles: [Profile] = []
  @Published private(set) var connection: Connection = .connecting
  @Published private(set) var dashboard = URL(string: "http://servedev.localhost")!
  /** Ids with a request in flight, so their row shows a spinner instead of buttons. */
  @Published private(set) var busy: Set<String> = []
  @Published var lastError: String?
  /**
   * Servers seen going into `crashed` while connected. Crashes already in a snapshot are old news,
   * so they stay out of Running and don't light up the menu bar icon.
   */
  @Published private(set) var recentCrashes: Set<String> = []
  /** Recent crashes the user hasn't opened the menu to see yet; these show the warning icon. */
  @Published private(set) var unseenCrashes: Set<String> = []

  private let client = DaemonClient()
  private var loop: Task<Void, Never>?

  init() {
    loop = Task { [weak self] in await self?.run() }
  }

  var list: [Server] { servers.values.sorted { ($0.project, $0.name, $0.id) < ($1.project, $1.name, $1.id) } }
  var runningCount: Int { servers.values.filter(\.isActive).count }

  func markCrashesSeen() {
    if !unseenCrashes.isEmpty { unseenCrashes = [] }
  }

  /** Keeps only the crash marks whose server is still crashed, e.g. after a reconnect's snapshot. */
  private func pruneCrashes() {
    let still = recentCrashes.filter { servers[$0]?.status == .crashed }
    if still != recentCrashes { recentCrashes = still }
    let unseen = unseenCrashes.intersection(still)
    if unseen != unseenCrashes { unseenCrashes = unseen }
  }

  func isRunning(_ profile: Profile) -> Bool {
    profile.servers.contains { servers[$0]?.isActive == true }
  }

  // MARK: Event loop

  /** Reconnects forever; waits grow while the daemon stays down so a stopped daemon costs little. */
  private func run() async {
    var delay: Double = 1
    while !Task.isCancelled {
      if connection != .connected { connection = .connecting }
      do {
        if let health = try? await client.health(), let url = health.dashboard.flatMap(URL.init(string:)) {
          dashboard = url
        }
        for try await (event, data) in client.events() {
          handle(event, data)
          delay = 1
        }
      } catch is CancellationError {
        return
      } catch {
        connection = .offline(describe(error))
      }
      try? await Task.sleep(for: .seconds(delay))
      delay = min(delay * 2, 10)
    }
  }

  private func describe(_ error: Error) -> String {
    if let urlError = error as? URLError, [.cannotConnectToHost, .networkConnectionLost, .timedOut, .cannotFindHost].contains(urlError.code) {
      return "servedev isn't running."
    }
    return error.localizedDescription
  }

  private func handle(_ event: String, _ data: Data) {
    let decoder = JSONDecoder()
    switch event {
    case "snapshot":
      guard let snap = try? decoder.decode(Snapshot.self, from: data) else { return }
      servers = Dictionary(snap.servers.compactMap(\.value).map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
      profiles = snap.profiles.compactMap(\.value)
      pruneCrashes()
      connection = .connected
    case "server":
      guard let server = try? decoder.decode(Server.self, from: data) else { return }
      let before = servers[server.id]?.status
      servers[server.id] = server
      // Only a change seen live counts; a snapshot full of old crashes would spam on every reconnect.
      if server.status == .crashed, before != .crashed {
        recentCrashes.insert(server.id)
        unseenCrashes.insert(server.id)
        Notifier.shared.crashed(server)
      } else if server.status != .crashed {
        recentCrashes.remove(server.id)
        unseenCrashes.remove(server.id)
      }
    case "remove":
      guard let removed = try? decoder.decode(Removed.self, from: data) else { return }
      servers[removed.id] = nil
      recentCrashes.remove(removed.id)
      unseenCrashes.remove(removed.id)
    case "profiles":
      guard let list = try? decoder.decode([Lossy<Profile>].self, from: data) else { return }
      profiles = list.compactMap(\.value)
    default:
      break
    }
  }

  // MARK: Actions

  func start(_ server: Server) {
    var body: [String: Any] = ["id": server.id, "wait": false]
    if let cwd = server.cwd { body["clientCwd"] = cwd }
    perform(server.id, "/api/start", body)
  }

  func stop(_ server: Server) { perform(server.id, "/api/stop", ["id": server.id]) }
  func restart(_ server: Server) { perform(server.id, "/api/restart", ["id": server.id, "wait": false]) }

  func startProfile(_ profile: Profile) {
    perform("profile:\(profile.id)", "/api/profiles/start", ["id": profile.id, "wait": false])
  }

  func stopProfile(_ profile: Profile) {
    perform("profile:\(profile.id)", "/api/servers/stop", ["ids": profile.servers])
  }

  func open(_ server: Server) {
    if let url = server.openURL { NSWorkspace.shared.open(url) }
  }

  func openDashboard() { NSWorkspace.shared.open(dashboard) }

  /** The CLI lives in Homebrew's bin, which a login shell has on PATH and a GUI app doesn't. */
  func startDaemon() {
    lastError = nil
    connection = .connecting
    Task.detached {
      let proc = Process()
      proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
      proc.arguments = ["-lc", "servedev daemon restart"]
      let pipe = Pipe()
      proc.standardOutput = pipe
      proc.standardError = pipe
      do {
        try proc.run()
        proc.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let failed = proc.terminationStatus != 0
        await MainActor.run {
          if failed { self.lastError = output.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").last.map(String.init) ?? "servedev daemon restart failed" }
          self.retry()
        }
      } catch {
        await MainActor.run { self.lastError = error.localizedDescription }
      }
    }
  }

  /** Skips the backoff wait: the user just asked, so try now. */
  func retry() {
    loop?.cancel()
    loop = Task { [weak self] in await self?.run() }
  }

  /** Clears busy on return; the row's new state arrives through the event stream, not the reply. */
  private func perform(_ id: String, _ path: String, _ body: [String: Any]) {
    busy.insert(id)
    lastError = nil
    Task {
      defer { busy.remove(id) }
      do {
        try await client.post(path, body)
      } catch {
        lastError = error.localizedDescription
      }
    }
  }
}
