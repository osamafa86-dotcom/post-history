import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

/// ما يتركه الإشعار على الجهاز خارج التطبيق: إشعارات مركز الإشعارات، والمجدولة محليًا، والرقم على الأيقونة.
public protocol NotificationCenterTraces: Sendable {
    func removeAllDelivered() async
    func removeAllPending() async
    func setBadgeCount(_ count: Int) async
}

/// الخروج والإبطال والمسح الطارئ: لا يبقى عنوان إشعار (رقم مادة وحالتها) على شاشة القفل ولا في مركز الإشعارات.
public enum NotificationTraceWiper {
    @discardableResult
    public static func wipe(_ center: any NotificationCenterTraces) async -> Int {
        await center.removeAllDelivered()
        await center.removeAllPending()
        await center.setBadgeCount(0)
        return 3
    }
}

#if canImport(UserNotifications) && os(iOS)
public struct SystemNotificationCenterTraces: NotificationCenterTraces {
    public init() {}
    public func removeAllDelivered() async { UNUserNotificationCenter.current().removeAllDeliveredNotifications() }
    public func removeAllPending() async { UNUserNotificationCenter.current().removeAllPendingNotificationRequests() }
    public func setBadgeCount(_ count: Int) async { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
}
#endif
