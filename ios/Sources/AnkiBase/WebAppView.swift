import SwiftUI
import WebKit

/// AnkiBase's web UI, full screen, behaving like an app rather than a web page: no zooming,
/// and what shows when you pull past the content, the status bar and the icon follow the theme.
/// The tab bar is a real UITabBar over the page; the page says what's on it (native.ts).
struct WebAppView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
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
        StoryAlerts.shared.open = { [weak coordinator = context.coordinator] path in
            coordinator?.send("ankibase-open", ["path": path])
        }
        web.load(URLRequest(url: AppSchemeHandler.start))

        // The tab bar, along the bottom (it makes room for the home indicator itself);
        // hidden until the page says what's on it.
        let tabs = context.coordinator.tabBar
        tabs.delegate = context.coordinator
        tabs.tintColor = theme.accent
        tabs.isHidden = true

        let container = UIView()
        for view in [web, tabs] as [UIView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(view)
        }
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: container.topAnchor),
            web.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            tabs.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            tabs.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            tabs.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {}

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
        let native: [String: Any] = [
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "platform": "ios",
            "reminders": Reminders.shared.state(),
            "tabBar": true,
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

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UITabBarDelegate {
        let handler = AppSchemeHandler()
        weak var web: WKWebView?
        let tabBar = UITabBar()

        // MARK: The tab bar

        struct Tab: Equatable {
            let to: String
            let label: String
            let symbol: String
            /// A count on the tab (decks behind, on Study); nil for none.
            let badge: String?
        }

        private var tabs: [Tab] = []

        /// A `{type: "tabs"}` message from the page (native.ts setNativeTabs).
        private func showTabs(_ next: [Tab], selected: String?, hidden: Bool) {
            if next != tabs {
                tabs = next
                tabBar.setItems(next.enumerated().map { index, tab in
                    let item = UITabBarItem(title: tab.label, image: UIImage(systemName: tab.symbol), tag: index)
                    item.badgeValue = tab.badge
                    item.badgeColor = Theme.shared.accent
                    return item
                }, animated: false)
            }
            tabBar.selectedItem = tabBar.items?.first { item in selected.map { tabs[item.tag].to == $0 } ?? false }
            tabBar.isHidden = hidden || next.isEmpty
        }

        func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
            guard tabs.indices.contains(item.tag) else { return }
            send("ankibase-tab", ["to": tabs[item.tag].to])
        }

        // MARK: Messages from the page (native.ts)

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "theme":
                Theme.shared.update(page: body["page"] as? String ?? "", bar: body["bar"] as? String ?? "",
                                    accent: body["accent"] as? String ?? "", dark: body["dark"] as? Bool ?? true, icon: body["icon"] as? String)
                if let web, let color = UIColor(hex: body["bar"] as? String ?? "") {
                    WebAppView.paint(web, color: color)
                }
                tabBar.tintColor = Theme.shared.accent
                tabBar.items?.forEach { $0.badgeColor = Theme.shared.accent }
            case "tabs":
                let items = (body["items"] as? [[String: Any]] ?? []).map {
                    Tab(to: $0["to"] as? String ?? "/", label: $0["label"] as? String ?? "", symbol: $0["symbol"] as? String ?? "circle",
                        badge: $0["badge"] as? String)
                }
                showTabs(items, selected: body["selected"] as? String, hidden: body["hidden"] as? Bool ?? false)
            case "haptic":
                switch body["style"] as? String {
                case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
                case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
                case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
            case "reminders":
                Reminders.shared.update(enabled: body["enabled"] as? Bool ?? false, hour: body["hour"] as? Int ?? 9,
                                        minute: body["minute"] as? Int ?? 0,
                                        strings: body["strings"] as? [String: String] ?? [:]) { [weak self] state in
                    self?.send("ankibase-reminders", state)
                }
            case "reminders-refresh":
                Reminders.shared.refresh()
            case "ready":
                StoryAlerts.shared.pageReady()
            case "story-alerts":
                StoryAlerts.shared.requestPermission()
            default:
                break
            }
        }

        /// An event for the page (native.ts listens for it).
        func send(_ event: String, _ detail: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: detail) else { return }
            let json = String(decoding: data, as: UTF8.self)
            web?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)', {detail: \(json)}))")
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
