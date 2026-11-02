import XCTest
import PostHistoryAPI
@testable import MaterialsCore

/// مادة للمعرض بما يلزم الفلتر والتجميع: العنوان والنوع والأولوية والحساسية ووقت الإرسال والملفات.
func galleryMaterial(_ title: String = "توزيع مساعدات", types: Set<MaterialType> = [.eyewitness], priority: Priority = .normal,
                     sensitive: Bool = false, created: Date = Date(timeIntervalSince1970: 1_800_000_000),
                     technical: TechnicalState = .verified, editorial: EditorialState = .inbox, rights: RightsState = .unknown,
                     files: [MaterialFile] = []) -> Material {
    Material(title: title, materialTypes: types, governorate: "دير البلح", city: "النصيرات", priority: priority,
             sensitivity: Sensitivity(minors: sensitive, injured: false, graphic: false),
             displayName: DisplayName(mode: .network), formVersion: 1, dynamicFields: [:],
             id: UUID(), version: 1, reporterId: UUID(), officeId: nil, technicalState: technical, editorialState: editorial,
             rightsState: rights, files: files, createdAt: created, updatedAt: created)
}

func mediaFile(_ kind: MaterialFile.Kind, _ state: MaterialFile.State = .verified, mime: String? = nil, durationMs: Int? = nil,
               proxyMode: MaterialFile.ProxyMode? = nil, width: Int? = nil, height: Int? = nil,
               created: Date = Date(timeIntervalSince1970: 1_800_000_000)) -> MaterialFile {
    MaterialFile(id: UUID(), kind: kind, state: state, proxyMode: proxyMode, mimeType: mime, durationMs: durationMs,
                 width: width, height: height, createdAt: created)
}

final class MaterialGalleryTests: XCTestCase {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Gaza")!
        return c
    }

    /// الأربعاء 2026-11-04 15:00 بتوقيت غزة.
    private let now: Date = {
        var c = DateComponents()
        (c.year, c.month, c.day, c.hour) = (2026, 11, 4, 15)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Gaza")!
        return cal.date(from: c)!
    }()

    private func ago(days: Double, hours: Double = 0) -> Date { now.addingTimeInterval(-(days * 86_400 + hours * 3_600)) }

    func testCoverageTitleDropsTheBatchSuffixAndFoldsArabicVariants() {
        XCTAssertEqual(CoverageTitle.display("توزيع مساعدات في النصيرات (2/3)"), "توزيع مساعدات في النصيرات")
        XCTAssertEqual(CoverageTitle.display("  غرق الخيام   بعد المنخفض (12/20) "), "غرق الخيام بعد المنخفض")
        // ليست لاحقة إرسالة: رقم خارج المدى، أو ملف واحد، أو نص غير رقمي، أو أرقام غير ASCII.
        XCTAssertEqual(CoverageTitle.display("مؤتمر (3/2)"), "مؤتمر (3/2)")
        XCTAssertEqual(CoverageTitle.display("مؤتمر (1/1)"), "مؤتمر (1/1)")
        XCTAssertEqual(CoverageTitle.display("قمة (G/7)"), "قمة (G/7)")
        XCTAssertEqual(CoverageTitle.display("مؤتمر (\u{0662}/\u{0663})"), "مؤتمر (\u{0662}/\u{0663})")
        XCTAssertEqual(CoverageTitle.display("(1/2)"), "(1/2)", "a title that is only a suffix stays as it is")
        // الهمزة والتاء المربوطة ومحرف الاتجاه الخفي لا تفرّق مواد التغطية الواحدة.
        XCTAssertEqual(CoverageTitle.key("أحداث المنطقة الوسطى (1/2)"), CoverageTitle.key("احداث المنطقه الوسطى\u{200F} (2/2)"))
        XCTAssertNotEqual(CoverageTitle.key("أحداث الشمال"), CoverageTitle.key("أحداث الجنوب"))
    }

    func testGroupingByCoverageKeepsTheBatchTogetherNewestFirst() {
        let a1 = galleryMaterial("توزيع مساعدات (1/3)", created: ago(days: 0, hours: 3))
        let b1 = galleryMaterial("غرق الخيام", types: [.report], created: ago(days: 1))
        let a2 = galleryMaterial("توزيع مساعدات (2/3)", created: ago(days: 0, hours: 2))
        let a3 = galleryMaterial("توزيع مساعدات (3/3)", created: ago(days: 0, hours: 2))
        let sections = MaterialGallery.sections([b1, a1, a2, a3], grouping: .coverage, kind: { _ in .video }, now: now, calendar: calendar)
        XCTAssertEqual(sections.map(\.heading), [.coverage("توزيع مساعدات"), .coverage("غرق الخيام")])
        // الأحدث أولًا، والمتساوي في الوقت بترتيب الخادم.
        XCTAssertEqual(sections[0].materials.map(\.id), [a2.id, a3.id, a1.id])
        XCTAssertEqual(sections[0].newest, a2.createdAt)
        XCTAssertEqual(sections[0].primaryType, .eyewitness)
        XCTAssertEqual(sections[1].materials.map(\.id), [b1.id])
        XCTAssertEqual(sections[1].primaryType, .report)
    }

    func testGroupingByTypeUsesTheFirstTypeInContractOrder() {
        let report = galleryMaterial("أ", types: [.report], created: ago(days: 2))
        let mixed = galleryMaterial("ب", types: [.photos, .breaking], created: ago(days: 0))
        let untyped = galleryMaterial("ج", types: [], created: ago(days: 1))
        let breaking = galleryMaterial("د", types: [.breaking], created: ago(days: 3))
        let sections = MaterialGallery.sections([report, mixed, untyped, breaking], grouping: .type, kind: { _ in .video },
                                                now: now, calendar: calendar)
        XCTAssertEqual(sections.map(\.heading), [.type(.breaking), .type(nil), .type(.report)])
        XCTAssertEqual(sections[0].materials.map(\.id), [mixed.id, breaking.id])
    }

    func testQuickChipsFilterByMediaKindAndUrgency() {
        let video = galleryMaterial("فيديو", created: ago(days: 0))
        let photo = galleryMaterial("صورة", created: ago(days: 0))
        let urgent = galleryMaterial("عاجل", priority: .urgent, created: ago(days: 0))
        let kinds: [UUID: MediaKind] = [video.id: .video, photo.id: .photo, urgent.id: .video]
        func ids(_ quick: GalleryQuickFilter) -> Set<UUID> {
            Set(MaterialGallery.sections([video, photo, urgent], grouping: .type, filter: GalleryFilter(quick: quick),
                                         kind: { kinds[$0.id]! }, now: now, calendar: calendar).flatMap { $0.materials.map(\.id) })
        }
        XCTAssertEqual(ids(.all), [video.id, photo.id, urgent.id])
        XCTAssertEqual(ids(.video), [video.id, urgent.id])
        XCTAssertEqual(ids(.photo), [photo.id])
        XCTAssertEqual(ids(.urgent), [urgent.id])
    }

    func testDateRangesFollowLocalCalendarDays() {
        let earlyToday = galleryMaterial(created: calendar.startOfDay(for: now).addingTimeInterval(60))
        let lateYesterday = galleryMaterial(created: calendar.startOfDay(for: now).addingTimeInterval(-60))
        let sixDays = galleryMaterial(created: calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now))!)
        let sevenDays = galleryMaterial(created: calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: now))!)
        let twentyNine = galleryMaterial(created: calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: now))!)
        let thirty = galleryMaterial(created: calendar.date(byAdding: .day, value: -30, to: calendar.startOfDay(for: now))!)
        let future = galleryMaterial(created: now.addingTimeInterval(3_600))
        let all = [earlyToday, lateYesterday, sixDays, sevenDays, twentyNine, thirty, future]
        func matching(_ range: GalleryDateRange) -> [UUID] {
            all.filter { GalleryFilter(dateRange: range).matches($0, kind: .video, now: now, calendar: calendar) }.map(\.id)
        }
        XCTAssertEqual(matching(.any).count, all.count)
        XCTAssertEqual(matching(.today), [earlyToday.id, future.id])
        XCTAssertEqual(matching(.week), [earlyToday.id, lateYesterday.id, sixDays.id, future.id])
        XCTAssertEqual(matching(.month), [earlyToday.id, lateYesterday.id, sixDays.id, sevenDays.id, twentyNine.id, future.id])
    }

    func testCoverageTypeAndStateFiltersEachReadTheirOwnTrack() {
        let processing = galleryMaterial(types: [.report], technical: .originalReceived, editorial: .inbox)
        let needsChanges = galleryMaterial(types: [.interview], technical: .verified, editorial: .needsChanges)
        let failed = galleryMaterial(types: [.report], technical: .failed, editorial: .inbox)
        let approved = galleryMaterial(types: [.report], technical: .verified, editorial: .accepted, rights: .sellable)
        let rejected = galleryMaterial(types: [.report], technical: .verified, editorial: .rejected)
        let all = [processing, needsChanges, failed, approved, rejected]
        func matching(_ filter: GalleryFilter) -> [UUID] { all.filter { filter.matches($0, kind: .video, now: now, calendar: calendar) }.map(\.id) }
        XCTAssertEqual(matching(GalleryFilter(coverageType: .interview)), [needsChanges.id])
        XCTAssertEqual(matching(GalleryFilter(state: .needsAction)), [needsChanges.id, failed.id])
        XCTAssertEqual(matching(GalleryFilter(state: .processing)), [processing.id])
        XCTAssertEqual(matching(GalleryFilter(state: .inReview)), [processing.id, needsChanges.id, failed.id])
        XCTAssertEqual(matching(GalleryFilter(state: .approved)), [approved.id])
        XCTAssertEqual(matching(GalleryFilter(state: .rejected)), [rejected.id])
        XCTAssertEqual(matching(GalleryFilter(state: .listed)), [approved.id])
        XCTAssertEqual(matching(GalleryFilter(coverageType: .report, state: .inReview)), [processing.id, failed.id])
    }

    func testActiveFilterCountsWhatTheSheetHolds() {
        XCTAssertFalse(GalleryFilter().isActive)
        XCTAssertEqual(GalleryFilter(quick: .photo).sheetCount, 0)
        XCTAssertTrue(GalleryFilter(quick: .photo).isActive)
        XCTAssertEqual(GalleryFilter(dateRange: .week, coverageType: .aerial, state: .approved).sheetCount, 3)
    }

    func testGroupDayIsTodayYesterdayOrTheDate() {
        XCTAssertEqual(GalleryDay.of(ago(days: 0, hours: 14), now: now, calendar: calendar), .today)
        XCTAssertEqual(GalleryDay.of(ago(days: 0, hours: 16), now: now, calendar: calendar), .yesterday)
        let old = ago(days: 3)
        XCTAssertEqual(GalleryDay.of(old, now: now, calendar: calendar), .date(old))
    }

    func testMediaKindReadsTheServerThenThePhoneThenTheDerivatives() {
        XCTAssertEqual(MaterialMedia.kind(of: galleryMaterial(files: [mediaFile(.original, mime: "image/heic")])), .photo)
        XCTAssertEqual(MaterialMedia.kind(of: galleryMaterial(files: [mediaFile(.original, mime: "video/quicktime")])), .video)
        XCTAssertEqual(MaterialMedia.kind(of: galleryMaterial(files: [mediaFile(.original)]), localMimeType: "image/jpeg"), .photo)
        XCTAssertEqual(MaterialMedia.kind(of: galleryMaterial(types: [.photos], files: [mediaFile(.original), mediaFile(.proxy)])), .video)
        XCTAssertEqual(MaterialMedia.kind(of: galleryMaterial(types: [.photos], files: [mediaFile(.original)])), .photo)
        XCTAssertEqual(MaterialMedia.kind(of: galleryMaterial(types: [.report])), .video)
        XCTAssertTrue(MaterialMedia.isImage(mimeType: nil, path: "Uploads/abc.HEIC"))
        XCTAssertFalse(MaterialMedia.isImage(mimeType: nil, path: "Uploads/abc.mov"))
        XCTAssertFalse(MaterialMedia.isImage(mimeType: "video/mp4", path: "Uploads/abc.jpg"))
    }

    func testDurationPrefersTheOriginalThenHlsThenTheLightCopy() {
        let both = galleryMaterial(files: [mediaFile(.proxy, durationMs: 101_000), mediaFile(.original, durationMs: 102_000)])
        XCTAssertEqual(MaterialMedia.durationMs(of: both), 102_000)
        let proxyOnly = galleryMaterial(files: [mediaFile(.original, durationMs: 0), mediaFile(.proxy, durationMs: 101_000)])
        XCTAssertEqual(MaterialMedia.durationMs(of: proxyOnly), 101_000)
        XCTAssertNil(MaterialMedia.durationMs(of: galleryMaterial(files: [mediaFile(.thumbnail)])))
    }

    func testSensitivityIsAnyOfTheThreeAnswers() {
        XCTAssertFalse(galleryMaterial().isSensitive)
        XCTAssertTrue(galleryMaterial(sensitive: true).isSensitive)
    }
}
