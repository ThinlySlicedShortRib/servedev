import ServiceManagement
import SwiftUI

/** The menu bar window: running servers first, then profiles, pins and the long tail of stopped ones. */
struct MenuView: View {
  @EnvironmentObject var store: Store
  @State private var query = ""
  @State private var showStopped = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      Divider()
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
        TextField("Search", text: $query)
          .textFieldStyle(.roundedBorder)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
        // A bare ScrollView always takes its full height; this only scrolls when the list overflows.
        ViewThatFits(in: .vertical) {
          paddedContent
          ScrollView { paddedContent }
        }
        .frame(maxHeight: 420)
      }
      Divider()
      footer
    }
    .frame(width: 340)
    // Opening the menu counts as seeing the crashes. onAppear can miss later openings of a .window
    // MenuBarExtra, so the window becoming key (this app's only window) is watched as well.
    .onAppear { store.markCrashesSeen() }
    .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
      store.markCrashesSeen()
    }
  }

  // MARK: Sections

  private var header: some View {
    HStack(spacing: 8) {
      Text("servedev").font(.headline)
      if store.connection == .connected {
        Text("\(store.runningCount) running").foregroundStyle(.secondary)
      }
      Spacer()
      Button {
        store.openDashboard()
      } label: {
        Label("Open Dashboard", systemImage: "macwindow")
      }
      .controlSize(.small)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
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

  private var filtered: [Server] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty else { return store.list }
    return store.list.filter { s in
      [s.name, s.project, s.id, s.branch ?? "", s.machine ?? "", s.port.map(String.init) ?? ""]
        .contains { $0.lowercased().contains(q) }
    }
  }

  private var filteredProfiles: [Profile] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty else { return store.profiles }
    return store.profiles.filter { p in
      [p.name, p.project ?? "", p.branch ?? ""].contains { $0.lowercased().contains(q) }
    }
  }

  private var paddedContent: some View {
    content
      .padding(.horizontal, 6)
      .padding(.bottom, 6)
  }

  @ViewBuilder
  private var content: some View {
    let servers = filtered
    // Old crashes sit with the stopped servers (red dot, "crashed" subtitle) instead of in Running.
    let isRunning = { (s: Server) in s.isActive || store.recentCrashes.contains(s.id) }
    let running = servers.filter(isRunning)
    let pinned = servers.filter { $0.pinned == true && !isRunning($0) }
    let stopped = servers.filter { $0.pinned != true && !isRunning($0) }
    let profiles = filteredProfiles
    let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty

    VStack(alignment: .leading, spacing: 2) {
      if !running.isEmpty {
        SectionTitle("Running")
        ForEach(running) { ServerRow(server: $0) }
      }
      if !profiles.isEmpty {
        SectionTitle("Profiles")
        ForEach(profiles) { ProfileRow(profile: $0) }
      }
      if !pinned.isEmpty {
        SectionTitle("Pinned")
        ForEach(pinned) { ServerRow(server: $0) }
      }
      if !stopped.isEmpty {
        // A search should show its matches, not hide them behind a collapsed group.
        DisclosureGroup(isExpanded: Binding(get: { searching || showStopped }, set: { showStopped = $0 })) {
          LazyVStack(alignment: .leading, spacing: 2) {
            ForEach(stopped) { ServerRow(server: $0) }
          }
        } label: {
          Text("Stopped (\(stopped.count))")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 6)
        .padding(.top, 8)
      }
      if running.isEmpty && profiles.isEmpty && pinned.isEmpty && stopped.isEmpty {
        Text(searching ? "Nothing matches “\(query)”." : "No servers yet.")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
          .padding(20)
      }
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
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
      HStack {
        if Bundle.main.bundleIdentifier != nil {
          LaunchAtLoginToggle()
        }
        Spacer()
        Button("Quit") { NSApp.terminate(nil) }
          .keyboardShortcut("q")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }
}

private struct SectionTitle: View {
  let title: String
  init(_ title: String) { self.title = title }

  var body: some View {
    Text(title)
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(.secondary)
      .padding(.horizontal, 6)
      .padding(.top, 8)
      .padding(.bottom, 2)
  }
}

// MARK: Rows

private struct ServerRow: View {
  @EnvironmentObject var store: Store
  let server: Server
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 8) {
      StatusDot(status: server.status)
      VStack(alignment: .leading, spacing: 1) {
        Text(server.name)
          .foregroundStyle(store.recentCrashes.contains(server.id) ? .red : .primary)
          .lineLimit(1)
        Text(subtitle)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 4)
      if store.busy.contains(server.id) {
        ProgressView().controlSize(.small)
      } else {
        buttons
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 4)
    .background(RoundedRectangle(cornerRadius: 6).fill(hovering ? Color.primary.opacity(0.07) : .clear))
    .onHover { hovering = $0 }
    .help(server.error ?? server.id)
  }

  /** "pc · project · :3000 · branch": where it runs, what it is and how to reach it. */
  private var subtitle: String {
    var parts: [String] = []
    if let machine = server.machine { parts.append(machine) }
    parts.append(server.project)
    if let port = server.port ?? server.url.flatMap({ URL(string: $0)?.port }) { parts.append(":\(port)") }
    if let branch = server.branch, !branch.isEmpty { parts.append(branch) }
    if server.status == .crashed { parts.append("crashed") }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder
  private var buttons: some View {
    HStack(spacing: 2) {
      if server.status == .running, server.openURL != nil {
        IconButton("arrow.up.forward.square", help: "Open") { store.open(server) }
      }
      if server.isActive || server.status == .crashed {
        IconButton("arrow.clockwise", help: "Restart") { store.restart(server) }
      }
      if server.isActive {
        IconButton("stop.fill", help: "Stop") { store.stop(server) }
      } else {
        IconButton("play.fill", help: "Start") { store.start(server) }
      }
    }
    .disabled(server.stale == true)
  }
}

private struct ProfileRow: View {
  @EnvironmentObject var store: Store
  let profile: Profile

  var body: some View {
    let running = store.isRunning(profile)
    let active = profile.servers.filter { store.servers[$0]?.isActive == true }.count
    HStack(spacing: 8) {
      Image(systemName: "square.stack.3d.up")
        .foregroundStyle(running ? .green : .secondary)
        .frame(width: 10)
      VStack(alignment: .leading, spacing: 1) {
        Text(profile.name).lineLimit(1)
        Text(running ? "\(active) of \(profile.servers.count) running" : "\(profile.servers.count) servers")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 4)
      if store.busy.contains("profile:\(profile.id)") {
        ProgressView().controlSize(.small)
      } else if running {
        IconButton("stop.fill", help: "Stop profile") { store.stopProfile(profile) }
      } else {
        IconButton("play.fill", help: "Start profile") { store.startProfile(profile) }
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 4)
  }
}

private struct StatusDot: View {
  let status: Status

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 8, height: 8)
      .frame(width: 10)
  }

  private var color: Color {
    switch status {
    case .running: .green
    case .starting, .stopping: .orange
    case .crashed: .red
    default: .secondary.opacity(0.5)
    }
  }
}

private struct IconButton: View {
  let symbol: String
  let help: String
  let action: () -> Void

  init(_ symbol: String, help: String, action: @escaping () -> Void) {
    self.symbol = symbol
    self.help = help
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .frame(width: 18, height: 18)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .help(help)
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
