import Foundation

/** A server as the daemon's /api/servers and event stream show it (only the fields the menu uses). */
struct Server: Decodable, Identifiable, Equatable {
  let id: String
  let name: String
  let project: String
  let cwd: String?
  let status: Status
  let port: Int?
  let url: String?
  /** Its custom hostname through the daemon's proxy, e.g. http://keel.localhost. */
  let customUrl: String?
  /** Set for another machine's servers ("pc"). */
  let machine: String?
  /** Another machine's server while that machine isn't connected: its last known state. */
  let stale: Bool?
  let branch: String?
  let pinned: Bool?
  let error: String?
  let exitCode: Int?
  /** Milliseconds since 1970, when its last run ended. */
  let stoppedAt: Double?

  var openURL: URL? { (customUrl ?? url).flatMap(URL.init(string:)) }
  var isActive: Bool { status == .starting || status == .running || status == .stopping }
}

enum Status: String, Decodable {
  case starting, running, stopping, stopped, exited, crashed, unknown

  init(from decoder: Decoder) throws {
    self = Status(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
  }
}

/** A profile: a named set of servers started together. */
struct Profile: Decodable, Identifiable, Equatable {
  let id: String
  let name: String
  let kind: String
  /** Server ids it starts, in order. */
  let servers: [String]
  /** Every server it lists, skipped ones included. */
  let members: [String]?
  let project: String?
  let branch: String?
}

/** Decodes what it can: one odd entry doesn't drop the whole list. */
struct Lossy<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

struct Snapshot: Decodable {
  let servers: [Lossy<Server>]
  let profiles: [Lossy<Profile>]
}

struct Removed: Decodable { let id: String }

/** /api/logs: the newest lines of a server's latest run. */
struct LogTail: Decodable {
  let lines: [String]
}

struct Health: Decodable {
  let version: String
  let dashboard: String?
}
