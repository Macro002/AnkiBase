import SwiftUI
import WebKit

/// AnkiBase's web UI, full screen, behaving like an app rather than a web page: no zooming,
/// and what shows when you pull past the content, the status bar and the icon follow the theme.
struct WebAppView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator.handler, forURLScheme: AppSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(context.coordinator, name: "ankibase")
        config.userContentController.addUserScript(WKUserScript(source: Self.bootScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let web = WKWebView(frame: .zero, configuration: config)
        let theme = Theme.shared
        web.isOpaque = false
        Self.paint(web, color: theme.bar)
        // The page handles the notch, Dynamic Island and home indicator (viewport-fit=cover).
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = true
        web.scrollView.alwaysBounceVertical = true
        web.scrollView.pinchGestureRecognizer?.isEnabled = false
        web.allowsBackForwardNavigationGestures = true
        web.allowsLinkPreview = false
        web.isInspectable = true
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        context.coordinator.web = web
        web.load(URLRequest(url: AppSchemeHandler.start))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    /// Pulling past the top or bottom shows this: the theme's header / tab bar colour, so the
    /// page looks like it continues under them.
    static func paint(_ web: WKWebView, color: UIColor) {
        web.backgroundColor = color
        web.scrollView.backgroundColor = color
        web.underPageBackgroundColor = color
    }

    /// Runs before the page: tells it it's in the app, and turns off zooming.
    private static var bootScript: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let native: [String: String] = [
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "platform": "ios",
        ]
        let json = (try? JSONSerialization.data(withJSONObject: native)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return """
        window.ankibaseNative = \(json);
        (function () {
          var content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
          function apply() {
            var meta = document.querySelector('meta[name=viewport]');
            if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; (document.head || document.documentElement).appendChild(meta); }
            if (meta.content !== content) meta.content = content;
          }
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
        })();
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let handler = AppSchemeHandler()
        weak var web: WKWebView?

        // MARK: Messages from the page (native.ts)

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "theme":
                Theme.shared.update(page: body["page"] as? String ?? "", bar: body["bar"] as? String ?? "",
                                    dark: body["dark"] as? Bool ?? true, icon: body["icon"] as? String)
                if let web, let color = UIColor(hex: body["bar"] as? String ?? "") {
                    WebAppView.paint(web, color: color)
                }
            case "haptic":
                switch body["style"] as? String {
                case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
                case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
                case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
            default:
                break
            }
        }

        // MARK: Navigation

        /// Links out of the app open in Safari (or the app they belong to, like SideStore).
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

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // WebKit re-creates the pinch recognizer for new pages.
            webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        }

        /// The web view's process can be killed in the background; start over.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // MARK: alert() and confirm()

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
