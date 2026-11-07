import BackgroundTasks
import UIKit
import UserNotifications

/// A notification when the daily story is ready (Settings → AI → Daily story).
///
/// The server writes it (backend/daily_story.py) and can't reach the phone, so the app looks
/// for it in a background app refresh: iOS runs that now and then, when it sees fit. A
/// story that's new since the last look and still unread is announced; tapping the
/// notification opens it in Reading.
final class StoryAlerts: NSObject, UNUserNotificationCenterDelegate {
    static let shared = StoryAlerts()
    /// Also in Info.plist (BGTaskSchedulerPermittedIdentifiers).
    static let task = "ankibase.stories"

    private let defaults = UserDefaults.standard
    /// The newest story id seen so far, by the app or in a notification.
    private static let seenKey = "stories.seen"
    private let queue = DispatchQueue(label: "ankibase.stories")

    /// Opens a page in the web view (WebAppView sets it). A tap that arrives before the page
    /// is ready waits in `pending` until the page says it is (`{type: "ready"}`).
    var open: ((String) -> Void)?
    private var pending: String?
    private var ready = false

    /// At launch, before the app finishes launching (BGTaskScheduler requires it).
    func register() {
        UNUserNotificationCenter.current().delegate = self
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.task, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return task.setTaskCompleted(success: false) }
            self.run(task)
        }
    }

    /// Ask iOS for the next look (when the app goes to the background, and after each look).
    func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: Self.task)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        do { try BGTaskScheduler.shared.submit(request) } catch {
            NSLog("AnkiBase: couldn't schedule the story check: \(error.localizedDescription)")
        }
    }

    /// The app is being left: what's there now has been seen, so only later stories notify.
    func noteSeen() {
        queue.async { self.check(notify: false) }
    }

    /// A `{type: "story-alerts"}` message: the daily story was turned on in the app.
    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func run(_ task: BGAppRefreshTask) {
        schedule()
        var cancelled = false
        task.expirationHandler = { cancelled = true }
        queue.async {
            self.check(notify: true)
            task.setTaskCompleted(success: !cancelled)
        }
    }

    private struct Story: Decodable {
        let id: Int
        let name: String
        let read_at: String?
    }

    private func check(notify: Bool) {
        guard let stories = get("/api/stories?limit=1", as: StoriesAnswer.self)?.stories else { return }
        let newest = stories.first
        let seen = defaults.object(forKey: Self.seenKey) as? Int
        defaults.set(max(seen ?? 0, newest?.id ?? 0), forKey: Self.seenKey)
        // The first look only notes what's there.
        guard notify, let seen, let story = newest, story.id > seen, story.read_at == nil else { return }
        guard get("/api/story/daily", as: Daily.self)?.enabled == true else { return }

        let content = UNMutableNotificationContent()
        content.title = "A new story is ready"
        content.body = story.name
        content.sound = .default
        content.threadIdentifier = "stories"
        content.userInfo = ["path": "/reading?story=\(story.id)"]
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "story-\(story.id)", content: content, trigger: nil))
    }

    private struct StoriesAnswer: Decodable { let stories: [Story] }
    private struct Daily: Decodable { let enabled: Bool }

    /// A GET to the core, as the web view would ask (it passes server requests on).
    private func get<T: Decodable>(_ target: String, as type: T.Type) -> T? {
        var status = 0
        var body = Data()
        let reply = Core.Reply(onHead: { code, _ in status = code }, onData: { data in body.append(data); return true })
        Core.handle(method: "GET", target: target, headers: [:], body: Data(), reply: reply)
        guard status == 200 else { return nil }
        return try? JSONDecoder().decode(T.self, from: body)
    }

    // MARK: Opening a tapped notification

    /// The page is up (`{type: "ready"}`): open what a tap asked for meanwhile.
    func pageReady() {
        ready = true
        if let path = pending {
            pending = nil
            open?(path)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        if let path = response.notification.request.content.userInfo["path"] as? String {
            DispatchQueue.main.async {
                if self.ready, let open = self.open { open(path) } else { self.pending = path }
            }
        }
        done()
    }

    /// In the app already: stories show as a banner; the reminders stay quiet, as before.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done(notification.request.content.threadIdentifier == "stories" ? [.banner, .sound] : [])
    }
}
