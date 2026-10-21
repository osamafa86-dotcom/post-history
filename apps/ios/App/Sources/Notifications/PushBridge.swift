import NotificationsCore
import UIKit
import UserNotifications

/// جسر APNs: الإذن والتسجيل، وتمرير رمز الجهاز إلى `PushRegistrar`، وفتح الإشعار عند لمسه.
/// الحمولة لا تحمل إلا المعرّفات والنوع والأولوية والعنوان من قالب الخادم (رقم المادة وحالتها).
@MainActor
final class PushBridge: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushBridge()
    var registrar: PushRegistrar?
    var onOpen: ((PushRoute) -> Void)?

    func activate() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// بعد الدخول: يُطلب الإذن مرة (النظام لا يعيد السؤال)، ثم التسجيل لدى APNs.
    func requestAuthorizationAndRegister() async {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    func deviceTokenReceived(_ token: Data) {
        guard let registrar else { return }
        Task { await registrar.deviceTokenReceived(token) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let route = PushRoute(userInfo: response.notification.request.content.userInfo) else { return }
        await MainActor.run { self.onOpen?(route) }
    }
}
