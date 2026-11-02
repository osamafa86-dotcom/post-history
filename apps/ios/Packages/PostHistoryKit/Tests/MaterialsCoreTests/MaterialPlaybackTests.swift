import XCTest
import PostHistoryAPI
import UploadCore
@testable import MaterialsCore

/// مصدر العرض (ADR 0089): نسخة الهاتف ← `hls` متحقَّق ← `proxy` متحقَّق ← «قيد المعالجة»؛ والأصل لا يُطلب له رابط أبدًا.
final class MaterialPlaybackTests: XCTestCase {
    private let local = LocalOriginal(recordId: UUID(), relativePath: "Uploads/a.mov", mimeType: "video/quicktime")

    func testTheCopyOnThePhoneWinsOverEveryServerDerivative() {
        let m = galleryMaterial(files: [mediaFile(.original), mediaFile(.hls), mediaFile(.proxy), mediaFile(.thumbnail)])
        XCTAssertEqual(PlaybackSourcePolicy.player(for: m, local: local), .local(local))
        XCTAssertEqual(PlaybackSourcePolicy.player(for: m, local: local).quality, .original)
        XCTAssertEqual(PlaybackSourcePolicy.thumbnail(for: m, local: local), .local(local))
    }

    func testHlsThenProxyAndOnlyWhenVerified() {
        let hls = mediaFile(.hls), proxy = mediaFile(.proxy, proxyMode: .normal)
        XCTAssertEqual(PlaybackSourcePolicy.player(for: galleryMaterial(files: [proxy, hls]), local: nil),
                       .remote(fileId: hls.id, kind: .hls, quality: .adaptive))
        for state: MaterialFile.State in [.uploading, .received, .failed, .unknownDefaultOpenApi] {
            let pending = mediaFile(.hls, state)
            XCTAssertEqual(PlaybackSourcePolicy.player(for: galleryMaterial(files: [pending, proxy]), local: nil),
                           .remote(fileId: proxy.id, kind: .proxy, quality: .lightCopy(lines: 540)), "\(state)")
            XCTAssertEqual(PlaybackSourcePolicy.player(for: galleryMaterial(files: [pending, mediaFile(.proxy, state)]), local: nil),
                           .unavailable, "\(state)")
        }
    }

    func testTheNewestVerifiedProxyIsChosen() {
        let old = mediaFile(.proxy, proxyMode: .urgent, created: Date(timeIntervalSince1970: 1))
        let new = mediaFile(.proxy, proxyMode: .normal, created: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(PlaybackSourcePolicy.player(for: galleryMaterial(files: [new, old]), local: nil),
                       .remote(fileId: new.id, kind: .proxy, quality: .lightCopy(lines: 540)))
    }

    func testAnOriginalOnlyUploadWithoutTheLocalCopyIsAnHonestPlaceholder() {
        // خادم التجربة بلا عامل وسائط: الأصل وصل وتحقّق، ولا مشتق؛ لا رابط يُطلب للأصل ولا لمصغّرة بدل الفيديو.
        let m = galleryMaterial(files: [mediaFile(.original, mime: "video/mp4"), mediaFile(.thumbnail), mediaFile(.audio)])
        XCTAssertEqual(PlaybackSourcePolicy.player(for: m, local: nil), .unavailable)
        XCTAssertNil(PlaybackSource.unavailable.quality)
        XCTAssertNil(PlaybackSourcePolicy.newestVerified(.original, in: m), "the original never gets a link")
        XCTAssertNil(PlaybackSourcePolicy.newestVerified(.voiceNote, in: galleryMaterial(files: [mediaFile(.voiceNote)])))
        XCTAssertFalse(PlaybackSourcePolicy.linkableKinds.contains(.original))
    }

    func testLightCopyQualityComesFromItsModeThenItsShortSide() {
        XCTAssertEqual(PlaybackQuality.lightCopy(mediaFile(.proxy, proxyMode: .urgent)), .lightCopy(lines: 360))
        XCTAssertEqual(PlaybackQuality.lightCopy(mediaFile(.proxy, proxyMode: .normal, width: 960, height: 540)), .lightCopy(lines: 540))
        XCTAssertEqual(PlaybackQuality.lightCopy(mediaFile(.proxy, width: 540, height: 960)), .lightCopy(lines: 540))
        XCTAssertEqual(PlaybackQuality.lightCopy(mediaFile(.proxy)), .lightCopy(lines: nil))
    }

    func testGridThumbnailsNeverAskTheServerForASensitiveMaterial() {
        let thumb = mediaFile(.thumbnail)
        XCTAssertEqual(PlaybackSourcePolicy.thumbnail(for: galleryMaterial(files: [thumb]), local: nil), .remote(fileId: thumb.id))
        XCTAssertEqual(PlaybackSourcePolicy.thumbnail(for: galleryMaterial(files: [mediaFile(.thumbnail, .received)]), local: nil), .unavailable)
        let sensitive = galleryMaterial(sensitive: true, files: [thumb, mediaFile(.proxy)])
        XCTAssertEqual(PlaybackSourcePolicy.thumbnail(for: sensitive, local: nil), .unavailable)
        XCTAssertEqual(PlaybackSourcePolicy.thumbnail(for: sensitive, local: local), .local(local))
    }

    func testAPhotoStillShowsOnlyOnRequestWhenSensitive() {
        let image = mediaFile(.proxy, mime: "image/jpeg"), thumb = mediaFile(.thumbnail)
        let photo = galleryMaterial(files: [mediaFile(.original, mime: "image/heic"), thumb, image])
        XCTAssertEqual(PlaybackSourcePolicy.still(for: photo, local: nil, requested: false), .remote(fileId: image.id))
        XCTAssertEqual(PlaybackSourcePolicy.still(for: galleryMaterial(files: [thumb, mediaFile(.proxy, mime: "video/mp4")]), local: nil,
                                                  requested: false), .remote(fileId: thumb.id))
        let sensitive = galleryMaterial(sensitive: true, files: [thumb])
        XCTAssertEqual(PlaybackSourcePolicy.still(for: sensitive, local: nil, requested: false), .unavailable)
        XCTAssertEqual(PlaybackSourcePolicy.still(for: sensitive, local: nil, requested: true), .remote(fileId: thumb.id))
        // ولا من الهاتف قبل اللمس: الصورة الحسّاسة لا تظهر وحدها أيًّا كان مصدرها.
        XCTAssertEqual(PlaybackSourcePolicy.still(for: sensitive, local: local, requested: false), .unavailable)
        XCTAssertEqual(PlaybackSourcePolicy.still(for: sensitive, local: local, requested: true), .local(local))
    }

    func testASensitiveMaterialStaysConcealedUntilTheReporterRevealsIt() {
        let sensitive = galleryMaterial(sensitive: true), plain = galleryMaterial()
        XCTAssertTrue(PlaybackSourcePolicy.conceals(sensitive, revealed: false))
        XCTAssertFalse(PlaybackSourcePolicy.conceals(sensitive, revealed: true))
        XCTAssertFalse(PlaybackSourcePolicy.conceals(plain, revealed: false))
    }

    func testAFailedHlsFallsBackOnceToTheVerifiedLightCopy() {
        let hls = mediaFile(.hls), proxy = mediaFile(.proxy, proxyMode: .urgent)
        let m = galleryMaterial(files: [hls, proxy, mediaFile(.proxy, .received)])
        let first = PlaybackSourcePolicy.player(for: m, local: nil)
        XCTAssertEqual(first, .remote(fileId: hls.id, kind: .hls, quality: .adaptive))
        let fallback = PlaybackSourcePolicy.fallback(after: first, for: m)
        XCTAssertEqual(fallback, .remote(fileId: proxy.id, kind: .proxy, quality: .lightCopy(lines: 360)))
        // مرة واحدة: لا بديل بعد النسخة الخفيفة، ولا لنسخة الهاتف، ولا بلا نسخة خفيفة متحقَّقة.
        XCTAssertNil(PlaybackSourcePolicy.fallback(after: fallback!, for: m))
        XCTAssertNil(PlaybackSourcePolicy.fallback(after: .local(local), for: m))
        XCTAssertNil(PlaybackSourcePolicy.fallback(after: first, for: galleryMaterial(files: [hls, mediaFile(.proxy, .uploading)])))
    }

    // MARK: أصل المادة على الهاتف بما وصل الخادم

    private func record(_ material: UUID, at seconds: TimeInterval, phase: UploadPhase, sha: String?,
                        kind: UploadSessionCreate.Kind = .original) -> UploadRecord {
        var r = UploadRecord(materialId: material, kind: kind, sourcePath: "Uploads/\(UUID().uuidString).mov", filename: "a.mov",
                             mimeType: "video/quicktime", sizeBytes: 1, now: Date(timeIntervalSince1970: seconds))
        r.phase = phase
        r.sha256Hex = sha
        return r
    }

    private func serverOriginal(sha: String?, _ state: MaterialFile.State = .verified) -> MaterialFile {
        var f = mediaFile(.original, state, mime: "video/quicktime")
        f.sha256 = sha
        return f
    }

    private func found(_ m: Material, _ records: [UploadRecord], onPhone: Set<UUID>? = nil) -> UUID? {
        LocalOriginals.find(for: m, in: records) { onPhone?.contains($0.id) ?? true }?.recordId
    }

    private let shaA = String(repeating: "a", count: 64), shaB = String(repeating: "b", count: 64)

    func testAReplacementShotTheServerRejectedIsNotShownAsTheOriginal() {
        // «رفع لقطة بديلة» لمادة تحقّق أصلها: الخادم يرد 409 فيصير السجل الأحدث `failed(.rejected)` وملفه باقٍ على الهاتف.
        var m = galleryMaterial(files: [serverOriginal(sha: shaA)])
        let accepted = record(m.id, at: 1, phase: .verified(receiptNumber: "R"), sha: shaA)
        let rejected = record(m.id, at: 2, phase: .failed(.rejected), sha: shaB)
        XCTAssertEqual(found(m, [accepted, rejected]), accepted.id, "the copy matching the server's fingerprint")
        // حذف المراسل نسخة الأصل المقبول من الهاتف: لا يُعرض المرفوض مكانه.
        XCTAssertEqual(found(m, [accepted, rejected], onPhone: [rejected.id]), nil)
        // الخادم لم يكتب البصمة بعد: الأصل متحقَّق ولا سجل يطابقه، فالفاشل والملغى لا يُعرضان.
        m.files = [serverOriginal(sha: nil)]
        XCTAssertEqual(found(m, [accepted, rejected]), accepted.id)
        let cancelled = record(m.id, at: 3, phase: .cancelled, sha: nil)
        XCTAssertEqual(found(m, [rejected, cancelled]), nil)
    }

    func testAFailedOriginalThenAnAcceptedReplacementShowsTheReplacement() {
        let m = galleryMaterial(files: [serverOriginal(sha: shaB)])
        let failed = record(m.id, at: 1, phase: .failed(.checksumMismatch), sha: shaA)
        let replacement = record(m.id, at: 2, phase: .verified(receiptNumber: "R"), sha: shaB.uppercased())
        XCTAssertEqual(found(m, [failed, replacement]), replacement.id)
        XCTAssertEqual(found(m, [replacement, failed]), replacement.id, "order of records does not matter")
    }

    func testBeforeTheServerVerifiesTheNewestUnfailedCopyIsShownThenAnyCopy() {
        // الأصل الأول فشل والبديل ما زال يُرفع: البديل.
        let m = galleryMaterial(technical: .pending, files: [serverOriginal(sha: nil, .uploading)])
        let failed = record(m.id, at: 1, phase: .failed(.expired), sha: shaA)
        let uploading = record(m.id, at: 2, phase: .transferring, sha: shaB)
        let olderUploading = record(m.id, at: 0, phase: .transferring, sha: nil)
        XCTAssertEqual(found(m, [failed, uploading, olderUploading]), uploading.id)
        // لم يصل شيء قط والنسخة الوحيدة لرفع فشل: هي ما صوّره المراسل فتُعرض.
        XCTAssertEqual(found(m, [failed]), failed.id)
        var bare = m
        bare.files = []
        XCTAssertEqual(found(bare, [failed]), failed.id)
    }

    func testOnlyThisMaterialsOriginalsStillOnThePhoneCount() {
        let m = galleryMaterial(technical: .pending)
        let kept = record(m.id, at: 1, phase: .transferring, sha: nil)
        let gone = record(m.id, at: 3, phase: .transferring, sha: nil)
        let proxy = record(m.id, at: 4, phase: .verified(receiptNumber: "R"), sha: nil, kind: .proxy)
        let other = record(UUID(), at: 5, phase: .transferring, sha: nil)
        let onPhone: Set<UUID> = [kept.id, proxy.id, other.id]
        XCTAssertEqual(LocalOriginals.find(for: m, in: [kept, gone, proxy, other]) { onPhone.contains($0.id) },
                       LocalOriginal(recordId: kept.id, relativePath: kept.sourcePath, mimeType: "video/quicktime"))
        XCTAssertNil(LocalOriginals.find(for: m, in: [gone, proxy, other]) { onPhone.contains($0.id) })
        XCTAssertTrue(LocalOriginal(recordId: UUID(), relativePath: "Uploads/x.jpg", mimeType: nil).isImage)
    }

    func testTheSignedLinkIsReusedOnlyWhileFreshAndRefreshedOnExpiry() {
        let now = Date(timeIntervalSince1970: 1_000)
        let url = URL(string: "https://storage.example.invalid/o/1?sig=x")!
        let fresh = SignedURLLease(url: url, expiresAt: now.addingTimeInterval(600))
        let closing = SignedURLLease(url: url, expiresAt: now.addingTimeInterval(SignedURLLease.safetyMargin))
        let expired = SignedURLLease(url: url, expiresAt: now.addingTimeInterval(-1))
        XCTAssertEqual(SignedURLRefresh.beforePlayback(nil, now: now), .fetchNew)
        XCTAssertEqual(SignedURLRefresh.beforePlayback(fresh, now: now), .useCurrent)
        XCTAssertEqual(SignedURLRefresh.beforePlayback(closing, now: now), .fetchNew, "inside the safety margin")
        XCTAssertEqual(SignedURLRefresh.beforePlayback(expired, now: now), .fetchNew)
        // نفاد الرابط أثناء المشاهدة: يُجدَّد ويُستأنف، ولا حلقة بلا تقدّم.
        XCTAssertEqual(SignedURLRefresh.afterFailure(expired, now: now, refreshesWithoutProgress: 0), .fetchNew)
        XCTAssertEqual(SignedURLRefresh.afterFailure(expired, now: now, refreshesWithoutProgress: 1), .fetchNew)
        XCTAssertEqual(SignedURLRefresh.afterFailure(expired, now: now, refreshesWithoutProgress: 2), .giveUp)
        XCTAssertEqual(SignedURLRefresh.afterFailure(nil, now: now, refreshesWithoutProgress: 0), .fetchNew)
        // رابط صالح وفشل: محاولة واحدة ثم توقف، فالسبب ليس الرابط.
        XCTAssertEqual(SignedURLRefresh.afterFailure(fresh, now: now, refreshesWithoutProgress: 0), .fetchNew)
        XCTAssertEqual(SignedURLRefresh.afterFailure(fresh, now: now, refreshesWithoutProgress: 1), .giveUp)
    }

    func testTheLeaseAcceptsOnlyAnHttpsLink() {
        let at = Date(timeIntervalSince1970: 5)
        XCTAssertEqual(SignedURLLease(FileDownloadUrl(url: "https://storage.example.invalid/o/1", expiresAt: at))?.expiresAt, at)
        XCTAssertNil(SignedURLLease(FileDownloadUrl(url: "http://storage.example.invalid/o/1", expiresAt: at)))
        XCTAssertNil(SignedURLLease(FileDownloadUrl(url: "https:///o/1", expiresAt: at)))
        XCTAssertNil(SignedURLLease(FileDownloadUrl(url: "file:///etc/passwd", expiresAt: at)))
        XCTAssertNil(SignedURLLease(FileDownloadUrl(url: "", expiresAt: at)))
    }

    func testFileRowsListTheOriginalFirstWithAWordForEachState() {
        let thumb = mediaFile(.thumbnail, .received)
        let proxy = mediaFile(.proxy, .verified, proxyMode: .urgent)
        var original = mediaFile(.original, .uploading)
        original.receiptNumber = "R-202611-000001"
        let rows = MaterialFileList.rows([thumb, proxy, original, mediaFile(.unknownDefaultOpenApi, .failed)])
        XCTAssertEqual(rows.map(\.kindKey), ["material.file.original", "material.file.proxy", "material.file.thumbnail", "material.file.other"])
        XCTAssertEqual(rows.map(\.stateKey), ["material.fileState.uploading", "material.fileState.verified", "material.fileState.received",
                                              "material.fileState.failed"])
        XCTAssertEqual(rows.map(\.tone), [.muted, .ok, .brand, .danger])
        XCTAssertEqual(rows[0].receiptNumber, "R-202611-000001")
        XCTAssertEqual(rows[1].quality, .lightCopy(lines: 360))
        XCTAssertEqual(rows[0].quality, .original)
        XCTAssertNil(rows[2].quality)
    }

    func testTheLatestTransitionPerTrackDatesTheExplanation() {
        func t(_ track: TransitionRecord.Track, _ to: String, _ seconds: TimeInterval) -> TransitionRecord {
            TransitionRecord(id: UUID().uuidString, track: track, from: "", to: to, reason: "", actorId: nil,
                             occurredAt: Date(timeIntervalSince1970: seconds))
        }
        let timeline = MaterialTimeline([t(.editorial, "acknowledged", 1), t(.editorial, "reviewing", 3), t(.technical, "verified", 2)])
        XCTAssertEqual(timeline.latest(.editorial)?.to, "reviewing")
        XCTAssertEqual(timeline.latest(.technical)?.to, "verified")
        XCTAssertNil(timeline.latest(.rights))
    }

    func testEveryNewTextKeyHasArabicAndEnglish() throws {
        let catalog = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../App/Resources/Localizable.xcstrings").standardized
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: catalog)) as! [String: Any]
        let strings = json["strings"] as! [String: Any]
        for key in MaterialStatus.allExplanationKeys + MaterialFileList.allTextKeys {
            let loc = (strings[key] as? [String: Any])?["localizations"] as? [String: Any]
            XCTAssertNotNil(loc?["ar"], "missing ar for \(key)")
            XCTAssertNotNil(loc?["en"], "missing en for \(key)")
        }
        XCTAssertEqual(Set(MaterialStatus.allExplanationKeys).count, 20)
    }
}
