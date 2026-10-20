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
        // A bare ScrollView always takes its full height; this only scrolls when the cards overflow.
        ViewThatFits(in: .vertical) {
          cards
          ScrollView { cards }
        }
        .frame(maxHeight: 480)
      }
      footer
    }
    .padding(12)
    .frame(width: 360)
    // Opening the menu counts as seeing the crashes. onAppear can miss later openings of a .window
    // MenuBarExtra, so the window becoming key (this app's only window) is watched as well.
    .onAppear { store.markCrashesSeen() }
    .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
      store.markCrashesSeen()
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
    let live = groups.filter { $0.servers.contains(where: isLive) }
    let pinned = groups.filter { g in !g.servers.contains(where: isLive) && g.servers.contains { $0.pinned == true } }
    let stopped = groups.filter { g in !g.servers.contains(where: isLive) && !g.servers.contains { $0.pinned == true } }

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
