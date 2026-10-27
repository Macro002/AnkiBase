import AnkiEngine
import Foundation

/// Anki's engine (engine/, Rust) with the collection stored on this phone.
enum Engine {
    struct Reply {
        let status: Int
        let contentType: String
        let body: Data
    }

    /// Where the collection, its media and the AnkiWeb login live.
    static let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Collection", isDirectory: true)
    }()

    /// Set when the collection couldn't be opened.
    nonisolated(unsafe) private(set) static var openError: String?

    private static let opened: Bool = {
        guard let error = ab_open(directory.path) else { return true }
        openError = String(cString: error)
        ab_string_free(error)
        return false
    }()

    /// Answer an AnkiBase API request, or nil when it isn't one of Anki's (the server's).
    /// Blocks while the engine works, so call it off the main thread.
    static func request(method: String, path: String, body: Data) -> Reply? {
        guard opened else {
            let detail = try? JSONSerialization.data(withJSONObject: ["detail": "Couldn't open the collection: \(openError ?? "")"])
            return path.hasPrefix("/api/") ? Reply(status: 500, contentType: "application/json", body: detail ?? Data()) : nil
        }
        let reply = body.withUnsafeBytes { bytes in
            ab_request(method, path, bytes.bindMemory(to: UInt8.self).baseAddress, body.count)
        }
        defer { ab_reply_free(reply) }
        guard reply.status != 0 else { return nil }
        let data = reply.body.map { Data(bytes: $0, count: reply.body_len) } ?? Data()
        let type = reply.content_type.map { String(cString: $0) } ?? "application/octet-stream"
        return Reply(status: Int(reply.status), contentType: type, body: data)
    }
}
