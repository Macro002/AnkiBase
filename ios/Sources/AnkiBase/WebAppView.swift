import SwiftUI
import WebKit

/// AnkiBase's web UI, full screen.
struct WebAppView: UIViewRepresentable {
    static var server: URL {
        if let saved = UserDefaults.standard.string(forKey: "server"), let url = URL(string: saved) { return url }
        let configured = Bundle.main.object(forInfoDictionaryKey: "AnkiBaseServer") as? String
        return URL(string: configured ?? "https://anki.macr0.dev")!
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator.handler, forURLScheme: AppSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let web = WKWebView(frame: .zero, configuration: config)
        let background = UIColor(red: 0x16 / 255, green: 0x21 / 255, blue: 0x3e / 255, alpha: 1)
        web.isOpaque = false
        web.backgroundColor = background
        web.scrollView.backgroundColor = background
        // The web UI handles the notch and home indicator itself (viewport-fit=cover).
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = true
        web.isInspectable = true
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.load(URLRequest(url: AppSchemeHandler.start))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let handler = AppSchemeHandler(server: WebAppView.server)

        /// Links out of the app open in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.scheme != AppSchemeHandler.scheme, url.scheme != "about" else {
                return decisionHandler(.allow)
            }
            if action.targetFrame?.isMainFrame ?? true {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { UIApplication.shared.open(url) }
            return nil
        }

        /// The web view's process can be killed in the background; start over.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(message, in: webView, actions: [("OK", .default, completionHandler)], fallback: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(message, in: webView, actions: [("Cancel", .cancel, { completionHandler(false) }),
                                                    ("OK", .default, { completionHandler(true) })],
                    fallback: { completionHandler(false) })
        }

        private func present(_ message: String, in webView: WKWebView,
                             actions: [(String, UIAlertAction.Style, () -> Void)], fallback: @escaping () -> Void) {
            guard var top = webView.window?.rootViewController else { return fallback() }
            while let presented = top.presentedViewController { top = presented }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            for (title, style, action) in actions {
                alert.addAction(UIAlertAction(title: title, style: style) { _ in action() })
            }
            top.present(alert, animated: true)
        }
    }
}
