import Foundation

struct DaemonError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/**
 * Talks to this machine's servedev daemon over HTTP, like the dashboard and CLI do: 127.0.0.1 on
 * $SERVEDEV_PORT (7777), with the token in $SERVEDEV_HOME/token (~/.servedev/token).
 */
final class DaemonClient: @unchecked Sendable {
  let base: URL
  let tokenFile: URL
  private let session: URLSession
  /** The event stream stays open; the daemon pings every 15 s, so a quiet minute means it's gone. */
  private let streamSession: URLSession

  init() {
    let env = ProcessInfo.processInfo.environment
    let home = env["SERVEDEV_HOME"].map { URL(fileURLWithPath: $0) }
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".servedev")
    base = URL(string: "http://127.0.0.1:\(env["SERVEDEV_PORT"] ?? "7777")")!
    tokenFile = home.appendingPathComponent("token")
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 120
    session = URLSession(configuration: config)
    let stream = URLSessionConfiguration.ephemeral
    stream.timeoutIntervalForRequest = 60
    stream.timeoutIntervalForResource = .infinity
    streamSession = URLSession(configuration: stream)
  }

  /** Read each time: the daemon creates it on first start, after this app may have launched. */
  private func token() throws -> String {
    guard let t = try? String(contentsOf: tokenFile, encoding: .utf8) else {
      throw DaemonError(message: "No token at \(tokenFile.path); start servedev once to create it.")
    }
    return t.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
    var req = URLRequest(url: base.appendingPathComponent(path))
    req.httpMethod = method
    req.setValue(try token(), forHTTPHeaderField: "x-servedev-token")
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "content-type")
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    return req
  }

  func health() async throws -> Health {
    var req = URLRequest(url: base.appendingPathComponent("/api/health"))
    req.timeoutInterval = 2
    let (data, _) = try await session.data(for: req)
    return try JSONDecoder().decode(Health.self, from: data)
  }

  func get(_ path: String, _ query: [String: String] = [:]) async throws -> Data {
    var req = try request(path)
    var parts = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
    parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
    req.url = parts.url
    let (data, res) = try await session.data(for: req)
    if let http = res as? HTTPURLResponse, http.statusCode >= 400 {
      let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw DaemonError(message: message ?? "servedev answered \(http.statusCode)")
    }
    return data
  }

  @discardableResult
  func post(_ path: String, _ body: [String: Any]) async throws -> Data {
    let (data, res) = try await session.data(for: try request(path, method: "POST", body: body))
    if let http = res as? HTTPURLResponse, http.statusCode >= 400 {
      let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw DaemonError(message: message ?? "servedev answered \(http.statusCode)")
    }
    return data
  }

  /** /api/stream/events as (event, data) pairs: a snapshot first, then changes. */
  func events() -> AsyncThrowingStream<(String, Data), Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let (bytes, res) = try await streamSession.bytes(for: try request("/api/stream/events"))
          if let http = res as? HTTPURLResponse, http.statusCode != 200 {
            throw DaemonError(message: http.statusCode == 401 ? "servedev rejected the token" : "servedev answered \(http.statusCode)")
          }
          // Each event is an "event:" line then one "data:" line (JSON on one line). `lines` skips
          // the blank separators, so an event is complete at its data line.
          var event = "message"
          for try await line in bytes.lines {
            if line.hasPrefix("event:") {
              event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
              continuation.yield((event, Data(line.dropFirst(5).utf8)))
              event = "message"
            }
          }
          continuation.finish(throwing: DaemonError(message: "servedev closed the connection"))
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
