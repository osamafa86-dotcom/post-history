import Foundation
import MediaCore
import Network
import PostHistoryAPI
import UIKit

/// حالة الجهاز لاختيار وضع النسخة الخفيفة (ADR 0075). تُقرأ محليًا ولا تخرج من الجهاز ولا تُسجَّل.
@MainActor
enum DeviceConditions {
    static func context(isVideo: Bool, durationSeconds: Double, priority: Priority) async -> ProxyContext {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let level = UIDevice.current.batteryLevel
        let free = try? URL(fileURLWithPath: NSHomeDirectory())
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
        return ProxyContext(isVideo: isVideo, durationSeconds: durationSeconds, priority: priority, network: await network(),
                            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
                            batteryLevel: level < 0 ? nil : Double(level), freeBytes: free)
    }

    /// المسار الحالي مرة واحدة: معطّل، أو وضع البيانات المنخفضة، أو مكلف (خلوي)، أو غير محدود.
    static func network() async -> ProxyContext.Network {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            let once = ResumeOnce()
            monitor.pathUpdateHandler = { path in
                guard once.claim() else { return }
                monitor.cancel()
                let network: ProxyContext.Network = path.status != .satisfied ? .offline
                    : path.isConstrained ? .constrained : path.isExpensive ? .expensive : .unmetered
                continuation.resume(returning: network)
            }
            monitor.start(queue: DispatchQueue(label: "net.palpost.posthistory.path"))
        }
    }
}

/// يضمن استئنافًا واحدًا حين يُستدعى المعالج أكثر من مرة.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { defer { done = true }; return !done } }
}
