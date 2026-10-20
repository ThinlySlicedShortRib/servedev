import Foundation
import UserNotifications

/**
 * Crash notifications. UNUserNotificationCenter traps without an app bundle, so under `swift run`
 * (no bundle identifier) this does nothing.
 */
@MainActor
final class Notifier {
  static let shared = Notifier()

  private var center: UNUserNotificationCenter? {
    Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
  }

  func requestAuthorization() {
    center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  func crashed(_ server: Server) {
    guard let center else { return }
    let content = UNMutableNotificationContent()
    content.title = "\(server.name) crashed"
    var detail = [server.machine, server.project].compactMap { $0 }.joined(separator: " · ")
    if let error = server.error, !error.isEmpty {
      detail += "\n\(error)"
    } else if let code = server.exitCode {
      detail += "\nExit code \(code)"
    }
    content.body = detail
    content.sound = .default
    // One per server: a crash loop replaces its notification instead of stacking them.
    center.add(UNNotificationRequest(identifier: "crash:\(server.id)", content: content, trigger: nil))
  }
}
