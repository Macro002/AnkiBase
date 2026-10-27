import SwiftUI
import UIKit

@main
struct AnkiBaseApp: App {
    @StateObject private var theme = Theme.shared

    init() {
        // Open the collection while the web view loads.
        DispatchQueue.global(qos: .userInitiated).async { _ = Core.started }
    }

    var body: some Scene {
        WindowGroup {
            WebAppView()
                .ignoresSafeArea()
                .background(Color(theme.bar).ignoresSafeArea())
                // The status bar's text: light on dark themes, dark on light ones.
                .preferredColorScheme(theme.dark ? .dark : .light)
        }
    }
}

/// The web UI's colours, so everything around the page matches it: the status bar, what
/// shows behind the page, and the home screen icon.
final class Theme: ObservableObject {
    static let shared = Theme()

    @Published private(set) var page: UIColor
    @Published private(set) var bar: UIColor
    @Published private(set) var dark: Bool

    private let defaults = UserDefaults.standard

    private init() {
        page = UIColor(hex: defaults.string(forKey: "theme.page") ?? "") ?? UIColor(red: 0x1a / 255, green: 0x1a / 255, blue: 0x2e / 255, alpha: 1)
        bar = UIColor(hex: defaults.string(forKey: "theme.bar") ?? "") ?? UIColor(red: 0x16 / 255, green: 0x21 / 255, blue: 0x3e / 255, alpha: 1)
        dark = defaults.object(forKey: "theme.dark") as? Bool ?? true
    }

    /// A `{type: "theme"}` message from the web UI (native.ts syncNativeTheme).
    func update(page: String, bar: String, dark: Bool, icon: String?) {
        if let color = UIColor(hex: page) { self.page = color }
        if let color = UIColor(hex: bar) { self.bar = color }
        self.dark = dark
        defaults.set(page, forKey: "theme.page")
        defaults.set(bar, forKey: "theme.bar")
        defaults.set(dark, forKey: "theme.dark")
        if let icon { setIcon(icon) }
    }

    /// The home screen icon for the theme (scripts/build.sh puts one per built-in theme in
    /// the app). iOS confirms the change with an alert of its own.
    private func setIcon(_ name: String) {
        let wanted: String? = name == "AnkiBase" ? nil : name
        let app = UIApplication.shared
        guard app.supportsAlternateIcons, app.alternateIconName != wanted else { return }
        if let wanted, !Self.alternateIcons.contains(wanted) { return }
        app.setAlternateIconName(wanted) { error in
            if let error { NSLog("AnkiBase: couldn't change the icon: \(error.localizedDescription)") }
        }
    }

    private static let alternateIcons: Set<String> = {
        let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        let alternates = icons?["CFBundleAlternateIcons"] as? [String: Any]
        return Set(alternates?.keys.map { $0 } ?? [])
    }()
}

extension UIColor {
    convenience init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                  blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}
