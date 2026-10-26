import XCTest
import PostHistoryAPI
@testable import MediaCore

/// اختيار وضع النسخة الخفيفة كما في جدول الخطة، وأبعادها.
final class ProxyPolicyTests: XCTestCase {
    private func ctx(video: Bool = true, seconds: Double = 600, priority: Priority = .normal, network: ProxyContext.Network = .expensive,
                     lowPower: Bool = false, battery: Double? = 0.8, free: Int64? = 10_000_000_000) -> ProxyContext {
        ProxyContext(isVideo: video, durationSeconds: seconds, priority: priority, network: network, lowPowerMode: lowPower, batteryLevel: battery, freeBytes: free)
    }

    func testTableOfModes() {
        XCTAssertEqual(ProxyPolicy.suggest(ctx()), .normal, "default on a metered network")
        XCTAssertEqual(ProxyPolicy.suggest(ctx(priority: .urgent)), .urgent, "breaking news")
        XCTAssertEqual(ProxyPolicy.suggest(ctx(network: .constrained)), .urgent, "Low Data Mode")
        XCTAssertEqual(ProxyPolicy.suggest(ctx(network: .offline)), .urgent, "queued offline for a weak network")
        XCTAssertEqual(ProxyPolicy.suggest(ctx(network: .unmetered)), .originalOnly, "good Wi-Fi")
        XCTAssertEqual(ProxyPolicy.suggest(ctx(priority: .urgent, network: .unmetered)), .urgent)
    }

    func testNoLightCopyForShortClipsPhotosOrLowBattery() {
        XCTAssertEqual(ProxyPolicy.suggest(ctx(seconds: 12)), .originalOnly)
        XCTAssertEqual(ProxyPolicy.suggest(ctx(video: false)), .originalOnly)
        XCTAssertEqual(ProxyPolicy.suggest(ctx(lowPower: true)), .originalOnly)
        XCTAssertEqual(ProxyPolicy.suggest(ctx(battery: 0.1)), .originalOnly)
        XCTAssertEqual(ProxyPolicy.suggest(ctx(battery: nil)), .normal)
    }

    func testFallsBackWhenStorageIsShort() {
        // 10 دقائق: عادي ~105 MB، عاجل ~53 MB؛ يلزم ضعفها مساحةً حرة.
        XCTAssertEqual(ProxyPolicy.suggest(ctx(free: 150_000_000)), .urgent)
        XCTAssertEqual(ProxyPolicy.suggest(ctx(free: 50_000_000)), .originalOnly)
    }

    func testUrgentTenMinutesIsAboutFortyFiveMegabytes() {
        let bytes = ProxyPreset.urgent.estimatedBytes(durationSeconds: 600)
        XCTAssertGreaterThan(bytes, 45_000_000)
        XCTAssertLessThan(bytes, 56_000_000)
    }

    func testRenderSizeKeepsAspectNeverUpscalesAndIsEven() {
        XCTAssertTrue(ProxyPreset.urgent.renderSize(displayWidth: 1920, displayHeight: 1080) == (640, 360))
        XCTAssertTrue(ProxyPreset.normal.renderSize(displayWidth: 1080, displayHeight: 1920) == (540, 960), "portrait phone video")
        XCTAssertTrue(ProxyPreset.normal.renderSize(displayWidth: 640, displayHeight: 480) == (640, 480), "no upscaling")
        let odd = ProxyPreset.urgent.renderSize(displayWidth: 1442, displayHeight: 1080)
        XCTAssertEqual(odd.width % 2, 0)
        XCTAssertEqual(odd.height, 360)
    }

    func testUploadModeMatchesTheContract() {
        XCTAssertEqual(ProxyChoice.urgent.uploadMode, .urgent)
        XCTAssertEqual(ProxyChoice.normal.uploadMode, .normal)
        XCTAssertNil(ProxyChoice.originalOnly.uploadMode)
    }
}
