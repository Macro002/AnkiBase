import CryptoKit
import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the app at ankibase://app/: AnkiBase's web UI from the app bundle, Anki's API
/// from the engine on this phone, and everything else from the AnkiBase server.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "ankibase"
    static let start = URL(string: "ankibase://app/")!

    private let server: URL
    private let webRoot: URL
    private let cache = ResponseCache()
    private let engineQueue = DispatchQueue(label: "AnkiBase.engine", qos: .userInitiated, attributes: .concurrent)
    /// Tasks WebKit hasn't stopped; answering a stopped task crashes.
    private var active = Set<ObjectIdentifier>()

    init(server: URL) {
        self.server = server
        webRoot = Bundle.module.url(forResource: "web", withExtension: nil)!.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        active.insert(ObjectIdentifier(task))
        guard let url = task.request.url,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return respond(task, status: 400, type: "text/plain", body: Data())
        }
        let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        let target = parts.percentEncodedQuery.map { "\(path)?\($0)" } ?? path

        if path.hasPrefix("/api/") {
            let method = task.request.httpMethod ?? "GET"
            let body = Self.body(of: task.request)
            engineQueue.async {
                if let reply = Engine.request(method: method, path: target, body: body) {
                    self.respond(task, status: reply.status, type: reply.contentType, body: reply.body)
                } else {
                    self.forward(task, target: target, body: body)
                }
            }
        } else if path.hasPrefix("/anki-pages/") {
            forward(task, target: target, body: Self.body(of: task.request))
        } else {
            serveFile(task, path: parts.path)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task))
    }

    // MARK: The web UI

    private func serveFile(_ task: WKURLSchemeTask, path: String) {
        var file = webRoot.appendingPathComponent(path).standardizedFileURL
        var isDirectory: ObjCBool = false
        let inside = file.path.hasPrefix(webRoot.path + "/")
        if !inside || !FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory) || isDirectory.boolValue {
            // A route of the single-page app.
            file = webRoot.appendingPathComponent("index.html")
        }
        guard let data = try? Data(contentsOf: file) else {
            return respond(task, status: 404, type: "text/plain", body: Data("Not found".utf8))
        }
        let type = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        respond(task, status: 200, type: type, body: data)
    }

    // MARK: The AnkiBase server

    private func forward(_ task: WKURLSchemeTask, target: String, body: Data) {
        guard let url = URL(string: target, relativeTo: server) else {
            return respond(task, status: 400, type: "text/plain", body: Data())
        }
        var request = URLRequest(url: url)
        request.httpMethod = task.request.httpMethod ?? "GET"
        for (name, value) in task.request.allHTTPHeaderFields ?? [:]
        where !["host", "origin", "referer", "cookie"].contains(name.lowercased()) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if !body.isEmpty { request.httpBody = body }
        let isGet = request.httpMethod == "GET"
        if target.hasPrefix("/api/auth/logout") { cache.clear() }

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let http = response as? HTTPURLResponse {
                let type = http.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
                let data = data ?? Data()
                if isGet && http.statusCode == 200 && target.hasPrefix("/api/") {
                    self.cache.store(target, type: type, body: data)
                }
                var headers = ["Content-Type": type]
                if let control = http.value(forHTTPHeaderField: "Cache-Control") { headers["Cache-Control"] = control }
                self.respond(task, status: http.statusCode, headers: headers, body: data)
            } else if isGet, let cached = self.cache.load(target) {
                // Offline: the last answer the server gave.
                self.respond(task, status: 200, headers: ["Content-Type": cached.type, "X-AnkiBase-Offline": "1"], body: cached.body)
            } else {
                let detail = "You're offline, and this needs the AnkiBase server (\(error?.localizedDescription ?? "no answer"))."
                let body = (try? JSONSerialization.data(withJSONObject: ["detail": detail])) ?? Data()
                self.respond(task, status: 503, type: "application/json", body: body)
            }
        }.resume()
    }

    // MARK: Helpers

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    private func respond(_ task: WKURLSchemeTask, status: Int, type: String, body: Data) {
        respond(task, status: status, headers: ["Content-Type": type], body: body)
    }

    private func respond(_ task: WKURLSchemeTask, status: Int, headers: [String: String], body: Data) {
        DispatchQueue.main.async {
            guard self.active.remove(ObjectIdentifier(task)) != nil, let url = task.request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                                 headerFields: headers.merging(["Content-Length": String(body.count)]) { a, _ in a })
            else { return }
            task.didReceive(response)
            task.didReceive(body)
            task.didFinish()
        }
    }
}

/// The server's last successful answers to GET requests, for when the phone is offline.
final class ResponseCache: @unchecked Sendable {
    private let directory: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("ServerResponses", isDirectory: true)
    }()
    private static let maxSize = 4 * 1024 * 1024

    private func file(_ target: String) -> URL {
        let digest = SHA256.hash(data: Data(target.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(digest)
    }

    func store(_ target: String, type: String, body: Data) {
        guard body.count <= Self.maxSize else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var record = Data(type.utf8)
        record.append(0)
        record.append(body)
        try? record.write(to: file(target), options: .atomic)
    }

    func load(_ target: String) -> (type: String, body: Data)? {
        guard let record = try? Data(contentsOf: file(target)), let split = record.firstIndex(of: 0) else { return nil }
        return (String(decoding: record[..<split], as: UTF8.self), Data(record[(split + 1)...]))
    }

    func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}
