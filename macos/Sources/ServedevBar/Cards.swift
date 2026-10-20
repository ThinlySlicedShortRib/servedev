import SwiftUI

/**
 * A profile as a Control Center tile. Clicking it narrows the menu to the profile's servers (again
 * to show everything); the round button in its corner starts or stops it. Running shows as a blue
 * fill, selection as a ring, so the two never look alike.
 */
struct ProfileTile: View {
  @EnvironmentObject var store: Store
  let profile: Profile

  var body: some View {
    let on = store.isRunning(profile)
    let selected = store.profileFilter == profile.id
    let active = profile.servers.filter { store.servers[$0]?.isActive == true }.count
    let busy = store.busy.contains("profile:\(profile.id)")
    Button {
      store.profileFilter = selected ? nil : profile.id
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        Image(systemName: "square.3.layers.3d")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(on ? Color.white : Color.primary)
          .frame(width: 28, height: 28)
          .background(Circle().fill(on ? Color.blue : Color.primary.opacity(0.16)))
        VStack(alignment: .leading, spacing: 1) {
          Text(profile.name)
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(1)
          Text(on ? "\(active) of \(profile.servers.count) running" : "Off · \(profile.servers.count) servers")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(RoundedRectangle(cornerRadius: 12).fill(on ? Color.blue.opacity(0.22) : Color.primary.opacity(0.08)))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(selected ? 0.85 : 0), lineWidth: 2))
      .contentShape(RoundedRectangle(cornerRadius: 12))
    }
    .buttonStyle(.plain)
    .help([profile.project, profile.branch].compactMap { $0 }.joined(separator: " · "))
    .accessibilityLabel(selected ? "Show all servers" : "Show only \(profile.name)")
    .accessibilityAddTraits(selected ? .isSelected : [])
    // Outside the tile's own button, so starting or stopping never changes the filter.
    .overlay(alignment: .topTrailing) {
      Group {
        if busy {
          ProgressView().controlSize(.mini)
        } else {
          Button {
            on ? store.stopProfile(profile) : store.startProfile(profile)
          } label: {
            Image(systemName: on ? "stop.fill" : "play.fill")
              .font(.system(size: 9, weight: .bold))
              .foregroundStyle(on ? Color.primary : Color.white)
              .frame(width: 22, height: 22)
              .background(Circle().fill(on ? Color.primary.opacity(0.16) : Color.blue))
              .contentShape(Circle())
          }
          .buttonStyle(.plain)
          .help(on ? "Stop \(profile.name)" : "Start \(profile.name)")
          .accessibilityLabel(on ? "Stop \(profile.name)" : "Start \(profile.name)")
        }
      }
      .frame(width: 22, height: 22)
      .padding(8)
    }
  }
}

/** One project's servers on a rounded card, with a switch for all of them. */
struct ProjectCard: View {
  @EnvironmentObject var store: Store
  let group: ProjectGroup
  @Binding var expanded: String?

  var body: some View {
    let active = group.servers.filter(\.isActive)
    let key = "project:\(group.id)"
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Text(group.title)
          .font(.system(size: 12, weight: .semibold))
          .lineLimit(1)
          .truncationMode(.middle)
        Text("\(active.count) of \(group.servers.count) on")
          .font(.system(size: 11))
          .foregroundStyle(.secondary)
        Spacer(minLength: 4)
        if store.busy.contains(key) {
          ProgressView().controlSize(.small)
        } else {
          Toggle("All servers in \(group.title)", isOn: Binding(
            get: { !active.isEmpty },
            set: { on in
              if on {
                store.startMany(group.servers.filter { !$0.isActive && $0.stale != true }.map(\.id), key: key)
              } else {
                store.stopMany(active.map(\.id), key: key)
              }
            }
          ))
          .toggleStyle(.switch)
          .controlSize(.mini)
          .labelsHidden()
          .tint(.green)
        }
      }
      .padding(.vertical, 6)
      ForEach(group.servers) { server in
        Divider()
        ServerRow(server: server, expanded: $expanded)
      }
    }
    .padding(.leading, 10)
    .padding(.trailing, 8)
    .padding(.vertical, 4)
    .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.06)))
  }
}

/** A server: click it to expand its actions and log tail; the switch starts or stops it. */
struct ServerRow: View {
  @EnvironmentObject var store: Store
  let server: Server
  @Binding var expanded: String?
  @State private var hovering = false

  private var isExpanded: Bool { expanded == server.id }
  private var crashed: Bool { server.status == .crashed }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Button {
          withAnimation(.easeOut(duration: 0.15)) { expanded = isExpanded ? nil : server.id }
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "chevron.right")
              .font(.system(size: 9, weight: .bold))
              .foregroundStyle(.secondary)
              .rotationEffect(.degrees(isExpanded ? 90 : 0))
            VStack(alignment: .leading, spacing: 1) {
              Text(server.name)
                .foregroundStyle(crashed ? Color.orange : Color.primary)
                .lineLimit(1)
              Text(subtitle)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            }
            Spacer(minLength: 0)
          }
          .padding(.vertical, 6)
          .padding(.horizontal, 4)
          .background(RoundedRectangle(cornerRadius: 7).fill(hovering ? Color.primary.opacity(0.06) : .clear))
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(server.id)

        if store.busy.contains(server.id) {
          ProgressView().controlSize(.small)
        } else {
          Toggle(server.name, isOn: Binding(
            get: { server.isActive },
            set: { $0 ? store.start(server) : store.stop(server) }
          ))
          .toggleStyle(.switch)
          .controlSize(.mini)
          .labelsHidden()
          .tint(.green)
          .disabled(server.stale == true)
        }
      }
      if isExpanded {
        ServerDetail(server: server)
          .padding(.bottom, 10)
          .padding(.top, 2)
      }
    }
  }

  /** "Crashed 09:12 · exit 1" for a crash; otherwise how to reach it and its branch. */
  private var subtitle: String {
    if crashed {
      var parts = ["Crashed"]
      if let at = server.stoppedAt {
        parts[0] += " " + Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .shortened)
      }
      if let code = server.exitCode { parts.append("exit \(code)") }
      return parts.joined(separator: " · ")
    }
    var parts: [String] = []
    if let host = server.customUrl.flatMap({ URL(string: $0)?.host }) {
      parts.append(host)
    } else if let port = server.port ?? server.url.flatMap({ URL(string: $0)?.port }) {
      parts.append(":\(port)")
    }
    if let branch = server.branch, !branch.isEmpty { parts.append(branch) }
    if server.pinned == true { parts.append("pinned") }
    if server.stale == true { parts.append("offline") }
    return parts.isEmpty ? server.status.rawValue : parts.joined(separator: " · ")
  }
}

/** The expanded part of a row: an action strip, the newest log lines and a link to the rest. */
private struct ServerDetail: View {
  @EnvironmentObject var store: Store
  let server: Server

  var body: some View {
    let remote = server.machine != nil
    let hasURL = (server.customUrl ?? server.url) != nil
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 2) {
        ActionButton("Open", "arrow.up.forward.square") { store.open(server) }
          .disabled(server.status != .running || server.openURL == nil)
        ActionButton("Restart", "arrow.clockwise") { store.restart(server) }
          .disabled(!server.isActive && server.status != .crashed)
        if server.isActive {
          ActionButton("Stop", "stop.fill") { store.stop(server) }
        } else {
          ActionButton("Start", "play.fill", prominent: true) { store.start(server) }
        }
        ActionButton("Logs", "text.alignleft") { store.openLogs(server) }
        ActionButton("Copy", "doc.on.doc") { store.copyURL(server) }
          .disabled(!hasURL)
        ActionButton(server.pinned == true ? "Unpin" : "Pin", server.pinned == true ? "pin.slash" : "pin") { store.togglePin(server) }
        ActionButton("Terminal", "terminal") { store.openTerminal(server) }
          .disabled(remote || server.cwd == nil)
        ActionButton("Editor", "chevron.left.forwardslash.chevron.right") { store.openEditor(server) }
          .disabled(remote || server.cwd == nil)
      }
      .padding(3)
      .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.07)))
      .disabled(store.busy.contains(server.id) || server.stale == true)

      LogBox(server: server)

      HStack(spacing: 5) {
        Circle().fill(liveColor).frame(width: 6, height: 6)
        Text(liveText)
        Spacer()
        Button("Full logs and run history") { store.openLogs(server) }
          .buttonStyle(.link)
      }
      .font(.system(size: 11))
      .foregroundStyle(.secondary)
    }
  }

  private var liveColor: Color {
    if server.isActive { return .green }
    return server.status == .crashed ? .orange : .gray
  }

  private var liveText: String {
    if server.isActive { return "Live tail" }
    if server.status == .crashed { return server.exitCode.map { "Exited · code \($0)" } ?? "Crashed" }
    return "Stopped · last run"
  }
}

/**
 * The newest few lines of the server's latest run. Polls every 2 s while the server is active and
 * the row is open; the task ends when the row collapses, and a stopped server is read once.
 */
private struct LogBox: View {
  @EnvironmentObject var store: Store
  let server: Server
  @State private var lines: [String]?
  @State private var failed: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let lines, !lines.isEmpty {
        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
          Text(line)
            .foregroundStyle(color(line))
            .lineLimit(1)
            .truncationMode(.tail)
        }
      } else {
        Text(failed ?? (lines == nil ? "Loading…" : "No output yet"))
          .foregroundStyle(Color(white: 0.56))
      }
    }
    .font(.system(size: 10.5, design: .monospaced))
    .lineSpacing(2)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 9)
    .padding(.vertical, 7)
    // Near-black in both appearances, like a terminal, so log colors read the same either way.
    .background(RoundedRectangle(cornerRadius: 8).fill(Color(white: 0.086)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.white.opacity(0.08)))
    .environment(\.colorScheme, .dark)
    .task(id: "\(server.id)|\(server.isActive)") {
      let live = server.isActive
      repeat {
        do {
          lines = try await store.logTail(server.id)
          failed = nil
        } catch is CancellationError {
          return
        } catch {
          failed = error.localizedDescription
        }
        if !live { return }
        try? await Task.sleep(for: .seconds(2))
      } while !Task.isCancelled
    }
  }

  private func color(_ line: String) -> Color {
    let lower = line.lowercased()
    if ["error", "failed", "exception", "fatal", "exited with code"].contains(where: lower.contains) {
      return Color(red: 1, green: 0.54, blue: 0.5)
    }
    return Color(white: 0.83)
  }
}

/** A labelled icon in the action strip; it lights up blue on hover like the mock. */
private struct ActionButton: View {
  let title: String
  let symbol: String
  let prominent: Bool
  let action: () -> Void
  @State private var hovering = false
  @Environment(\.isEnabled) private var isEnabled

  init(_ title: String, _ symbol: String, prominent: Bool = false, action: @escaping () -> Void) {
    self.title = title
    self.symbol = symbol
    self.prominent = prominent
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      VStack(spacing: 3) {
        Image(systemName: symbol)
          .font(.system(size: 13))
          .frame(height: 15)
        Text(title)
          .font(.system(size: 10))
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      .frame(maxWidth: .infinity)
      .padding(.top, 6)
      .padding(.bottom, 5)
      .foregroundStyle(prominent ? Color.white : Color.primary)
      .background(RoundedRectangle(cornerRadius: 8).fill(background))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .opacity(isEnabled ? 1 : 0.35)
    .onHover { hovering = $0 }
    .help(title)
  }

  private var background: Color {
    if prominent { return .blue }
    return hovering && isEnabled ? Color.blue.opacity(0.28) : .clear
  }
}
