import XCTest
@testable import DeviceSecurity

final class AppLockTests: XCTestCase {
    func testLockedAtLaunchOnlyWhenEnabled() {
        XCTAssertTrue(AppLockState(enabled: true).isLocked)
        XCTAssertFalse(AppLockState(enabled: false).isLocked)
    }

    func testBackgroundLocksAndOnlySuccessfulAuthenticationUnlocks() {
        var lock = AppLockState(enabled: true)
        lock.authenticationFinished(success: true)
        XCTAssertFalse(lock.isLocked)
        lock.didEnterBackground()
        XCTAssertTrue(lock.isLocked)
        lock.authenticationFinished(success: false)
        XCTAssertTrue(lock.isLocked, "a failed or cancelled prompt keeps the app locked")
        lock.authenticationFinished(success: true)
        XCTAssertFalse(lock.isLocked)
    }

    func testEnablingRequiresAuthenticationAndDisablingUnlocks() {
        var lock = AppLockState(enabled: false)
        XCTAssertFalse(lock.enable(authenticated: false))
        XCTAssertFalse(lock.isEnabled)
        lock.didEnterBackground()
        XCTAssertFalse(lock.isLocked, "nothing locks while the option is off")
        XCTAssertTrue(lock.enable(authenticated: true))
        lock.didEnterBackground()
        XCTAssertTrue(lock.isLocked)
        lock.disable()
        XCTAssertFalse(lock.isLocked)
        XCTAssertFalse(lock.isEnabled)
    }
}
