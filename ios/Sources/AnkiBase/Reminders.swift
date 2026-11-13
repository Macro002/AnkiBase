import UIKit
import UserNotifications

/// Settings → Reminders: a daily notification naming the decks that are behind (reviews or
/// learning cards due), and the app icon's badge with how many there are.
///
/// iOS doesn't wake the app to count, so whenever the app goes to the background or a sync
/// finishes, this schedules the next week's reminders, each with the decks the engine
/// predicts are behind that day (`GET /api/app/behind`). Studying in between changes that,
/// and the next time the app is left it's counted again.
final class Reminders {
    static let shared = Reminders()

    struct Settings: Codable {
        var enabled = false
        var hour = 9
        var minute = 0
        /// The notification's text in the web UI's language (RemindersSection.tsx).
        var strings: [String: String] = [:]
    }

    private(set) var settings: Settings
    private let center = UNUserNotificationCenter.current()
    private let queue = DispatchQueue(label: "ankibase.reminders")
    private static let key = "reminders"
    private static let days = 7

    private init() {
        settings = UserDefaults.standard.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode(Settings.self, from: $0) } ?? Settings()
    }

    /// What the page shows (window.ankibaseNative.reminders, and after each change).
    func state(denied: Bool = false) -> [String: Any] {
        ["enabled": settings.enabled, "hour": settings.hour, "minute": settings.minute, "denied": denied]
    }

    /// A `{type: "reminders"}` message from Settings. Turning them on asks for permission
    /// first; without it they stay off and the page says so.
    func update(enabled: Bool, hour: Int, minute: Int, strings: [String: String],
                done: @escaping ([String: Any]) -> Void) {
        settings = Settings(enabled: enabled, hour: hour, minute: minute, strings: strings)
        save()
        guard enabled else {
            refresh()
            return done(state())
        }
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if !granted {
                self.settings.enabled = false
                self.save()
            }
            self.refresh()
            DispatchQueue.main.async { done(self.state(denied: !granted)) }
        }
    }

    /// Count again and schedule the week's reminders, with time from iOS to finish when the
    /// app is going to the background.
    func refresh() {
        let app = UIApplication.shared
        var task = UIBackgroundTaskIdentifier.invalid
        task = app.beginBackgroundTask(withName: "Reminders") {
            app.endBackgroundTask(task)
            task = .invalid
        }
        queue.async {
            self.reschedule()
            DispatchQueue.main.async {
                if task != .invalid { app.endBackgroundTask(task) }
            }
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }

    private func reschedule() {
        center.removeAllPendingNotificationRequests()
        guard settings.enabled else {
            center.setBadgeCount(0, withCompletionHandler: nil)
            return
        }
        guard let days = behind(), let today = days.first else { return }
        center.setBadgeCount(today.decks.count, withCompletionHandler: nil)

        // A reminder at the chosen time on each of the coming days, with the decks behind on
        // the Anki day it falls in (they start at the day rollover, 4am by default).
        let calendar = Calendar.current
        let now = Date()
        let midnight = calendar.startOfDay(for: now)
        for offset in 0...Self.days {
            guard let date = calendar.date(byAdding: .day, value: offset, to: midnight),
                  let fire = calendar.date(bySettingHour: settings.hour, minute: settings.minute, second: 0, of: date),
                  fire > now else { continue }
            let index = Int(((fire.timeIntervalSince1970 - Double(today.starts)) / 86_400).rounded(.down))
            guard days.indices.contains(index), !days[index].decks.isEmpty else { continue }
            let content = UNMutableNotificationContent()
            content.title = text("title", "Time to study")
            content.body = body(days[index].decks)
            content.badge = NSNumber(value: days[index].decks.count)
            content.sound = .default
            let when = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
            let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: false)
            center.add(UNNotificationRequest(identifier: "reminder-\(offset)", content: content, trigger: trigger))
        }
    }

    /// "Spanish is waiting", "Spanish and Kanji are waiting", "Spanish, Kanji and 2 more…"
    private func body(_ decks: [String]) -> String {
        let and = text("and", "and")
        let names: String
        switch decks.count {
        case 1: names = decks[0]
        case 2, 3: names = decks.dropLast().joined(separator: ", ") + " \(and) " + decks.last!
        default:
            let more = text("more", "{count} more").replacingOccurrences(of: "{count}", with: String(decks.count - 2))
            names = decks.prefix(2).joined(separator: ", ") + " \(and) " + more
        }
        let template = decks.count == 1 ? text("one", "{decks} is waiting for you") : text("other", "{decks} are waiting for you")
        return template.replacingOccurrences(of: "{decks}", with: names)
    }

    private func text(_ key: String, _ fallback: String) -> String {
        settings.strings[key].flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    }

    private struct Day: Decodable {
        let starts: Int64
        let decks: [String]
    }

    /// The engine's prediction, asked the way the web view asks it.
    private func behind() -> [Day]? {
        var status = 0
        var body = Data()
        let reply = Core.Reply(onHead: { code, _ in status = code }, onData: { data in body.append(data); return true })
        Core.handle(method: "GET", target: "/api/app/behind", headers: [:], body: Data(), reply: reply)
        guard status == 200 else { return nil }
        struct Answer: Decodable { let days: [Day] }
        return (try? JSONDecoder().decode(Answer.self, from: body))?.days
    }
}
