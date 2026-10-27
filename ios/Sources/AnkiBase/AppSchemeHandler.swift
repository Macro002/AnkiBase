import Foundation
import UIKit
import WebKit

/// Serves the app at ankibase://app/: every request goes to the core (Core.swift), and its
/// reply streams back to the web view as it arrives.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "ankibase"
    static let start = URL(string: "ankibase://app/")!

    private let queue = DispatchQueue(label: "AnkiBase.core", qos: .userInitiated, attributes: .concurrent)
    /// Tasks WebKit hasn't stopped (answering a stopped task crashes). Main thread only.
    private var active = Set<ObjectIdentifier>()
    /// Read from the core's threads to stop streams nobody listens to any more.
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        active.insert(id)
        guard let url = task.request.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return finish(task, status: 400)
        }
        let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        let target = parts.percentEncodedQuery.map { "\(path)?\($0)" } ?? path
        let method = task.request.httpMethod ?? "GET"
        let headers = task.request.allHTTPHeaderFields ?? [:]
        let body = Self.body(of: task.request)

        // Let a sync or an upload finish when the app goes to the background.
        let background = UIApplication.shared.beginBackgroundTask(withName: "AnkiBase request")
        queue.async {
            let reply = Core.Reply(
                onHead: { status, headers in
                    DispatchQueue.main.async {
                        guard self.active.contains(id),
                              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
                        else { return }
                        task.didReceive(response)
                    }
                },
                onData: { data in
                    DispatchQueue.main.async {
                        if self.active.contains(id) { task.didReceive(data) }
                    }
                    self.lock.lock()
                    defer { self.lock.unlock() }
                    return !self.stopped.contains(id)
                }
            )
            Core.handle(method: method, target: target, headers: headers, body: body, reply: reply)
            DispatchQueue.main.async {
                if self.active.remove(id) != nil { task.didFinish() }
                self.lock.lock()
                self.stopped.remove(id)
                self.lock.unlock()
                UIApplication.shared.endBackgroundTask(background)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        active.remove(id)
        lock.lock()
        stopped.insert(id)
        lock.unlock()
    }

    private func finish(_ task: WKURLSchemeTask, status: Int) {
        guard active.remove(ObjectIdentifier(task)) != nil, let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])
        else { return }
        task.didReceive(response)
        task.didFinish()
    }

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
}
