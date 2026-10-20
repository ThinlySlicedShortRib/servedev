import ServiceManagement
import SwiftUI

/** Which machine's servers the menu shows. */
enum MachineFilter: Hashable {
  case local
  case remote(String)
  case all

  func includes(_ server: Server) -> Bool {
    switch self {
    case .local: server.machine == nil
    case .remote(let name): server.machine == name
    case .all: true
    }
  }
}

/** Servers of one project on one machine, shown as a card. */
struct ProjectGroup: Identifiable {
  let id: String
  let title: String
  let servers: [Server]
}

/**
 * The menu bar window, laid out like Control Center: profile tiles, then a card per project with
 * switches. Projects with something running (or freshly crashed) come first; the long tail of
 * stopped projects folds away.
 */
struct MenuView: View {
  @EnvironmentObject var store: Store
  @State private var query = ""
  @State private var machine: MachineFilter = .local
  @State private var expanded: String?
  @State private var showStopped = false
  @State private var confirmStopAll = false
  /** The cards' natural height; starts at the cap so the list is never 0 before it's measured. */
  @State private var cardsHeight: CGFloat = 480
  /** The whole menu's natural height, which the window is sized to. */
  @State private var contentHeight: CGFloat = 0
  @State private var windowRef = WindowRef()

  private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      if case .offline(let message) = store.connection {
        offline(message)
      } else if store.connection == .connecting && store.servers.isEmpty {
        HStack {
          Spacer()
          ProgressView().controlSize(.small)
          Text("Connecting…").foregroundStyle(.secondary)
          Spacer()
        }
        .padding(20)
      } else {
        if !store.machines.isEmpty { machinePicker }
        TextField("Search servers", text: $query)
          .textFieldStyle(.roundedBorder)
        if !profiles.isEmpty { profileTiles }
        if let name = filterName { filterBar(name) }
        // The menu window sizes itself to its content, and a ScrollView has no height of its own
        // (it would get 0). So the cards are measured and the scroll area gets exactly that, up to 480.
        ScrollView {
          cards.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in
            cardsHeight = max(h, 1)
          }
        }
        .frame(height: min(cardsHeight, 480))
      }
      footer
    }
    .padding(12)
    .frame(width: 360)
    // The menu window doesn't always shrink to its content, and SwiftUI centres shorter content in
    // it, which shows as empty bands above and below. So the content reports its exact height, the
    // window is resized to it (top edge kept under the menu bar), and any leftover goes below.
    .fixedSize(horizontal: false, vertical: true)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in
      contentHeight = h
      fitWindow()
    }
    .background(WindowReader { windowRef.window = $0; fitWindow() })
    .frame(maxHeight: .infinity, alignment: .top)
    // Opening the menu counts as seeing the crashes. onAppear can miss later openings of a .window
    // MenuBarExtra, so the window becoming key (this app's only window) is watched as well.
    .onAppear { store.markCrashesSeen() }
    .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
      store.markCrashesSeen()
      fitWindow()
    }
    // Closing the menu collapses the open row, which stops its log polling.
    .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { _ in
      expanded = nil
      confirmStopAll = false
    }
    .onChange(of: store.machines) { _, names in
      if case .remote(let name) = machine, !names.contains(name) { machine = .local }
    }
  }

  /** Makes the window exactly as tall as the content, growing or shrinking downwards from the menu bar. */
  private func fitWindow() {
    guard let window = windowRef.window, contentHeight > 0 else { return }
    let size = window.frameRect(forContentRect: NSRect(x: 0, y: 0, width: window.contentLayoutRect.width, height: contentHeight)).size
    guard abs(window.frame.height - size.height) > 0.5 else { return }
    var frame = window.frame
    frame.origin.y += frame.height - size.height
    frame.size.height = size.height
    window.setFrame(frame, display: true)
  }

  // MARK: Header and filters

  private var header: some View {
    HStack(spacing: 8) {
      Text("servedev").font(.system(size: 14, weight: .bold))
      if store.connection == .connected {
        Text("\(store.runningCount) of \(store.servers.count) running").foregroundStyle(.secondary)
      }
      Spacer()
      Button("Dashboard") { store.openDashboard() }
        .buttonStyle(.link)
        .font(.system(size: 12))
    }
  }

  private var machinePicker: some View {
    Picker("Machine", selection: $machine) {
      Text("This Mac · \(activeCount(.local))").tag(MachineFilter.local)
      ForEach(store.machines, id: \.self) { name in
        Text("\(name) · \(activeCount(.remote(name)))").tag(MachineFilter.remote(name))
      }
      Text("All").tag(MachineFilter.all)
    }
    .pickerStyle(.segmented)
    .labelsHidden()
  }

  private func activeCount(_ filter: MachineFilter) -> Int {
    store.servers.values.filter { filter.includes($0) && $0.isActive }.count
  }

  private func offline(_ message: String) -> some View {
    VStack(spacing: 10) {
      Image(systemName: "bolt.horizontal.circle")
        .font(.system(size: 28))
        .foregroundStyle(.secondary)
      Text(message)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Button("Start servedev") { store.startDaemon() }
          .keyboardShortcut(.defaultAction)
        Button("Retry") { store.retry() }
      }
    }
    .frame(maxWidth: .infinity)
    .padding(20)
  }

  // MARK: Profiles

  private var profiles: [Profile] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty else { return store.profiles }
    return store.profiles.filter { p in
      [p.name, p.project ?? "", p.branch ?? ""].contains { $0.lowercased().contains(q) }
    }
  }

  private var filterIds: Set<String>? { store.filterIds }

  private var filterName: String? {
    store.profileFilter.flatMap { id in store.profiles.first { $0.id == id }?.name }
  }

  private func filterBar(_ name: String) -> some View {
    HStack(spacing: 6) {
      Image(systemName: "line.3.horizontal.decrease.circle.fill")
        .foregroundStyle(.secondary)
      Text("Showing: ").foregroundStyle(.secondary) + Text(name).fontWeight(.semibold)
      Spacer()
      Button {
        store.profileFilter = nil
      } label: {
        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
      }
      .buttonStyle(.borderless)
      .help("Show all servers")
      .accessibilityLabel("Clear the \(name) filter")
    }
    .font(.system(size: 12))
    .lineLimit(1)
  }

  private var profileTiles: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 8), count: 3), spacing: 8) {
      ForEach(profiles) { ProfileTile(profile: $0) }
    }
  }

  // MARK: Cards

  private var filtered: [Server] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    return store.list.filter { s in
      guard machine.includes(s) else { return false }
      if let ids = filterIds, !ids.contains(s.id) { return false }
      guard !q.isEmpty else { return true }
      return [s.name, s.project, s.id, s.branch ?? "", s.machine ?? "", s.port.map(String.init) ?? ""]
        .contains { $0.lowercased().contains(q) }
    }
  }

  private func isLive(_ s: Server) -> Bool { s.isActive || store.recentCrashes.contains(s.id) }

  @ViewBuilder
  private var cards: some View {
    let groups = Dictionary(grouping: filtered) { "\($0.machine ?? "")\u{0}\($0.project)" }
      .map { key, servers in
        ProjectGroup(id: key, title: [servers[0].machine, servers[0].project].compactMap { $0 }.joined(separator: " · "), servers: servers)
      }
      .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    // A profile's list is short, so its stopped projects show in full instead of folding away.
    let fold = store.profileFilter == nil
    let live = groups.filter { $0.servers.contains(where: isLive) }
    let pinned = groups.filter { g in !g.servers.contains(where: isLive) && (!fold || g.servers.contains { $0.pinned == true }) }
    let stopped = fold ? groups.filter { g in !g.servers.contains(where: isLive) && !g.servers.contains { $0.pinned == true } } : []

    VStack(alignment: .leading, spacing: 8) {
      ForEach(live + pinned) { ProjectCard(group: $0, expanded: $expanded) }
      if !stopped.isEmpty {
        // A search should show its matches, not hide them behind a collapsed group.
        DisclosureGroup(isExpanded: Binding(get: { searching || showStopped }, set: { showStopped = $0 })) {
          LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(stopped) { ProjectCard(group: $0, expanded: $expanded) }
          }
          .padding(.top, 6)
        } label: {
          Text("Stopped · \(stopped.count) \(stopped.count == 1 ? "project" : "projects")")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .padding(.leading, 4)
      }
      if groups.isEmpty {
        Text(searching ? "Nothing matches “\(query)”." : "No servers yet.")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
          .padding(20)
      }
    }
  }

  // MARK: Footer

  private var stopAllIds: [String] {
    store.servers.values.filter { machine.includes($0) && $0.isActive }.map(\.id)
  }

  private var stopAllLabel: String {
    switch machine {
    case .local: "Stop all on This Mac"
    case .remote(let name): "Stop all on \(name)"
    case .all: "Stop all"
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let error = store.lastError {
        HStack(alignment: .top, spacing: 4) {
          Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
          Text(error)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          Button {
            store.lastError = nil
          } label: {
            Image(systemName: "xmark")
          }
          .buttonStyle(.borderless)
          .controlSize(.small)
        }
      }
      HStack(spacing: 8) {
        if store.connection == .connected {
          let ids = stopAllIds
          // Stopping everything is one click away from the menu, so it asks once more first.
          Button(confirmStopAll ? "Stop \(ids.count) servers?" : stopAllLabel) {
            if confirmStopAll {
              confirmStopAll = false
              store.stopMany(ids, key: "stop-all")
            } else {
              confirmStopAll = true
              Task {
                try? await Task.sleep(for: .seconds(3))
                confirmStopAll = false
              }
            }
          }
          .tint(confirmStopAll ? .red : nil)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .disabled(ids.isEmpty || store.busy.contains("stop-all"))
        }
        Spacer()
        if Bundle.main.bundleIdentifier != nil {
          LaunchAtLoginToggle()
        }
        Button("Quit") { NSApp.terminate(nil) }
          .buttonStyle(.bordered)
          .controlSize(.small)
          .keyboardShortcut("q")
      }
    }
  }
}

/** Holds the menu's window without making SwiftUI re-render when it's set. */
final class WindowRef {
  weak var window: NSWindow?
}

/** Reports the NSWindow its view lands in; SwiftUI has no direct way to reach the MenuBarExtra window. */
private struct WindowReader: NSViewRepresentable {
  let found: (NSWindow?) -> Void

  init(_ found: @escaping (NSWindow?) -> Void) { self.found = found }

  func makeNSView(context: Context) -> NSView { Probe(found: found) }
  func updateNSView(_ view: NSView, context: Context) {}

  private final class Probe: NSView {
    let found: (NSWindow?) -> Void
    init(found: @escaping (NSWindow?) -> Void) {
      self.found = found
      super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { nil }
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      let window = window
      DispatchQueue.main.async { self.found(window) }
    }
  }
}

/** Registers the bundled app as a login item; SMAppService only works from an .app bundle. */
private struct LaunchAtLoginToggle: View {
  @State private var enabled = SMAppService.mainApp.status == .enabled
  @EnvironmentObject var store: Store

  var body: some View {
    Toggle("Launch at login", isOn: Binding(get: { enabled }, set: set))
      .toggleStyle(.checkbox)
      .controlSize(.small)
  }

  private func set(_ on: Bool) {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      store.lastError = error.localizedDescription
    }
    enabled = SMAppService.mainApp.status == .enabled
  }
}
