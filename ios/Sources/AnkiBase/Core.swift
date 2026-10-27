import AnkiEngine
import Foundation

/// The app's core (engine/, Rust): the web UI, Anki with the collection on this phone, and
/// the AnkiBase server for what only it can do.
enum Core {
    /// The collection, its media, the sync login and the app's settings live here.
    static let directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]

    /// Set when the core couldn't start.
    nonisolated(unsafe) private(set) static var startError: String?

    static let started: Bool = {
        let info = Bundle.main.infoDictionary ?? [:]
        let config: [String: Any?] = [
            "dir": directory.path,
            "web": Bundle.module.url(forResource: "web", withExtension: nil)?.path,
            "pages": Bundle.module.url(forResource: "pages", withExtension: nil)?.path,
            "default_server": info["AnkiBaseServer"] as? String,
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "update_feed": info["AnkiBaseUpdateFeed"] as? String,
            "bundle_id": Bundle.main.bundleIdentifier,
        ]
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let json = (try? JSONSerialization.data(withJSONObject: config.compactMapValues { $0 })) ?? Data("{}".utf8)
        guard let error = ab_start(String(decoding: json, as: UTF8.self)) else { return true }
        startError = String(cString: error)
        ab_string_free(error)
        return false
    }()

    /// Where one reply goes. `onData` returns false once nobody wants the rest.
    final class Reply {
        let onHead: (Int, [String: String]) -> Void
        let onData: (Data) -> Bool

        init(onHead: @escaping (Int, [String: String]) -> Void, onData: @escaping (Data) -> Bool) {
            self.onHead = onHead
            self.onData = onData
        }
    }

    /// Answer a request. Blocks until the reply is complete, so call it off the main thread.
    static func handle(method: String, target: String, headers: [String: String], body: Data, reply: Reply) {
        guard started else {
            let detail = try? JSONSerialization.data(withJSONObject: ["detail": "The app couldn't start: \(startError ?? "")"])
            reply.onHead(500, ["Content-Type": "application/json"])
            _ = reply.onData(detail ?? Data())
            return
        }
        let headersJSON = (try? JSONSerialization.data(withJSONObject: headers)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        let context = Unmanaged.passUnretained(reply).toOpaque()
        let head: ab_head_fn = { context, status, headersJSON in
            let reply = Unmanaged<Reply>.fromOpaque(context!).takeUnretainedValue()
            var headers: [String: String] = [:]
            if let headersJSON, let data = String(cString: headersJSON).data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
                headers = parsed
            }
            reply.onHead(Int(status), headers)
        }
        let data: ab_data_fn = { context, bytes, count in
            let reply = Unmanaged<Reply>.fromOpaque(context!).takeUnretainedValue()
            guard let bytes, count > 0 else { return true }
            return reply.onData(Data(bytes: bytes, count: count))
        }
        withExtendedLifetime(reply) {
            body.withUnsafeBytes { raw in
                ab_handle(method, target, headersJSON, raw.bindMemory(to: UInt8.self).baseAddress, body.count, context, head, data)
            }
        }
    }
}
