import AppKit
import SwiftUI

@main
struct ServedevBarApp: App {
  @StateObject private var store = Store()

  init() {
    Notifier.shared.requestAuthorization()
  }

  var body: some Scene {
    MenuBarExtra {
      MenuView()
        .environmentObject(store)
    } label: {
      MenuLabel(store: store)
    }
    .menuBarExtraStyle(.window)
  }
}

/** The menu bar item: the running count at a glance, and a warning until a new crash has been seen. */
struct MenuLabel: View {
  @ObservedObject var store: Store

  var body: some View {
    switch store.connection {
    case .offline:
      // Menu bar images render as templates, which drop SwiftUI opacity; bake the dimming into the image.
      Image(nsImage: dimmedSymbol("server.rack"))
    default:
      HStack(spacing: 3) {
        Image(systemName: !store.unseenCrashes.isEmpty ? "exclamationmark.triangle.fill" : "server.rack")
        if store.runningCount > 0 {
          Text("\(store.runningCount)")
        }
      }
    }
  }
}

/** A template symbol drawn at partial alpha, so the menu bar shows it greyed out in light and dark. */
private func dimmedSymbol(_ name: String) -> NSImage {
  guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: "servedev offline") else { return NSImage() }
  let image = NSImage(size: symbol.size, flipped: false) { rect in
    symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 0.35)
    return true
  }
  image.isTemplate = true
  return image
}
