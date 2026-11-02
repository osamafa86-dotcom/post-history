import XCTest
import FormEngine
import PostHistoryAPI
@testable import MaterialsCore

/// شاشة الإرسال الواحدة (ADR 0088): الوسوم بقاعدة العقد، وسبب تعطيل «أرسل N مواد» بترتيبه، وسؤال الحساسية الواحد،
/// والمكان واسم الظهور المتذكَّران، ودوائر الرفع والإرسالات.
final class SendScreenCoreTests: XCTestCase {
    private func file(_ name: String, size: Int64 = 10, capturedAt: Date? = nil) -> MaterialDraft.PickedFile {
        .init(relativePath: "Uploads/\(name)", filename: name, sizeBytes: size, mimeType: "video/quicktime", isVideo: true, durationSeconds: 60,
              capturedAt: capturedAt)
    }

    /// مسودة مكتملة كما تملؤها الشاشة: ملفان، عنوان، نوع، وسم، مكان، «لا» للحساسية، واسم الظهور من الذاكرة.
    private func ready(answered: Bool = true) -> MaterialDraft {
        var d = MaterialDraft()
        d.files = [file("a.mov"), file("b.mov")]
        d.title = "توزيع مساعدات في المخيم"
        d.materialTypes = [.breaking]
        d.tags = ["مساعدات"]
        d.governorate = "دير البلح"; d.city = "النصيرات"
        d.priority = .normal
        if answered { d.answerSensitivity(.no) }
        d.displayMode = .realName
        d.formVersion = 1
        return d
    }

    private var repoRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../..").standardized
    }

    // MARK: الوسوم بقاعدة العقد

    func testTagRuleMatchesTheContractPattern() {
        for valid in ["غزة", "a", "حي الرمال", "Gaza 2026", "طفل\u{00A0}مصاب", String(repeating: "س", count: 40), "#عاجل"] {
            XCTAssertTrue(MaterialTagRules.isValid(valid), valid)
        }
        let invalid = [
            "", " غزة", "غزة ", "\u{00A0}غزة", "غزة\u{3000}", "\u{FEFF}غزة", "غزة\u{2028}",
            "غ\tزة", "غزة\n", "غ\u{0085}زة", "\u{200F}غزة", "غ\u{061C}زة", "غزة\u{2066}", "غ\u{202E}زة",
            String(repeating: "س", count: 41),
        ]
        for tag in invalid { XCTAssertFalse(MaterialTagRules.isValid(tag), tag.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: " ")) }
    }

    /// المحارف الممنوعة في كل موضع هي نفسها المعدَّدة في نمط `MaterialTag` بالعقد: إن تغيّر العقد فشل هذا الاختبار.
    func testForbiddenCharactersAreExactlyThoseInTheContract() throws {
        let yaml = try String(contentsOf: repoRoot.appendingPathComponent("contracts/openapi.yaml"), encoding: .utf8)
        let block = try XCTUnwrap(yaml.components(separatedBy: "    MaterialTag:\n").dropFirst().first)
        let patternLine = try XCTUnwrap(block.split(separator: "\n").first { $0.contains("pattern:") })
        // آخر مجموعة في النمط: ما يُمنع في كل موضع (بلا `\s`).
        let middle = try XCTUnwrap(patternLine.components(separatedBy: "(?:[^").last?.components(separatedBy: "]").first)
        var contract = Set<UInt32>()
        let tokens = middle.components(separatedBy: "\\\\u").dropFirst()
        var previous: UInt32?
        var rangeOpen = false
        for token in tokens {
            let value = try XCTUnwrap(UInt32(token.prefix(4), radix: 16))
            if rangeOpen, let start = previous {
                for v in start...value { contract.insert(v) }
                rangeOpen = false
            } else {
                contract.insert(value)
            }
            previous = value
            rangeOpen = token.dropFirst(4).hasPrefix("-")
        }
        XCTAssertGreaterThan(contract.count, 60)
        let ours = Set((0...0x3000).compactMap { Unicode.Scalar(UInt32($0)) }
            .filter { MaterialTagRules.isControl($0) || MaterialTagRules.isBidiControl($0) }.map(\.value))
        XCTAssertEqual(ours, contract)
        XCTAssertEqual(MaterialCreate.tagsRule.maxItems, MaterialTagRules.maxCount)
        XCTAssertTrue(block.contains("maxLength: \(MaterialTagRules.maxLength)"))
    }

    func testNormalizeRemovesInvisibleCharactersAndTrims() {
        XCTAssertEqual(MaterialTagRules.normalize("  غزة  "), "غزة")
        XCTAssertEqual(MaterialTagRules.normalize("\u{200F}غزة\u{200E}"), "غزة")
        XCTAssertEqual(MaterialTagRules.normalize("حي\n\tالرمال"), "حي الرمال")
        XCTAssertEqual(MaterialTagRules.normalize("حي\u{00A0}\u{00A0}الرمال\u{FEFF}"), "حي الرمال")
        XCTAssertEqual(MaterialTagRules.normalize("\u{2066}\u{2069}"), "")
    }

    func testAddingTagsReportsWhyNothingWasAdded() {
        var tags: [String] = []
        XCTAssertEqual(MaterialTagRules.add(" شتاء ", to: &tags), .added("شتاء"))
        XCTAssertEqual(MaterialTagRules.add("شتاء", to: &tags), .duplicate)
        XCTAssertEqual(MaterialTagRules.add("Gaza", to: &tags), .added("Gaza"))
        XCTAssertEqual(MaterialTagRules.add("gaza", to: &tags), .duplicate)
        XCTAssertEqual(MaterialTagRules.add("\u{200F} ", to: &tags), .empty)
        XCTAssertEqual(MaterialTagRules.add(String(repeating: "س", count: 41), to: &tags), .tooLong)
        for i in 0..<10 { MaterialTagRules.add("وسم\(i)", to: &tags) }
        XCTAssertEqual(tags.count, 12)
        XCTAssertEqual(MaterialTagRules.add("آخر", to: &tags), .limitReached)
        XCTAssertTrue(MaterialTagRules.isValidSet(tags))
        XCTAssertFalse(MaterialTagRules.isValidSet(tags + ["زيادة"]), "more than 12")
        XCTAssertFalse(MaterialTagRules.isValidSet(["أ", "أ"]), "duplicates")
    }

    func testSeparatorsCompleteTagsWhileTyping() {
        XCTAssertEqual(MaterialTagRules.split("غزة").complete, [])
        XCTAssertEqual(MaterialTagRules.split("غزة").remainder, "غزة")
        let arabicComma = MaterialTagRules.split("غزة\u{060C}رفح")
        XCTAssertEqual(arabicComma.complete, ["غزة"])
        XCTAssertEqual(arabicComma.remainder, "رفح")
        let many = MaterialTagRules.split("a,b,")
        XCTAssertEqual(many.complete, ["a", "b"])
        XCTAssertEqual(many.remainder, "")
    }

    func testInvalidTagsAreAContractIssueButMissingTagsAreNot() {
        var d = ready()
        d.tags = []
        XCTAssertEqual(DraftValidator.fieldIssues(d), [], "tags are optional in the contract")
        d.tags = ["\u{200F}غزة"]
        XCTAssertEqual(DraftValidator.fieldIssues(d), [.tagsInvalid])
        XCTAssertNil(DraftValidator.materialCreate(d, dynamicFields: [:]))
    }

    // MARK: المطابقة والاقتراحات

    func testArabicFoldIgnoresHamzaTaMarbutaAndAlefMaqsura() {
        XCTAssertEqual(ArabicFold.key("أطفال"), ArabicFold.key("اطفال"))
        XCTAssertEqual(ArabicFold.key("إسعاف"), ArabicFold.key("اسعاف"))
        XCTAssertEqual(ArabicFold.key("مدرسة"), ArabicFold.key("مدرسه"))
        XCTAssertEqual(ArabicFold.key("مستشفى"), ArabicFold.key("مستشفي"))
        XCTAssertEqual(ArabicFold.key("مُسْتَشْفَى"), ArabicFold.key("مستشفي"), "diacritics")
        XCTAssertEqual(ArabicFold.key("Gaza"), ArabicFold.key("GAZA"))
        XCTAssertNotEqual(ArabicFold.key("غزة"), ArabicFold.key("رفح"))
    }

    func testSuggestionsComeFromHistoryPrefixFirstAndSkipTagsAlreadyAdded() {
        let history = ["مساعدات", "أطفال", "طوابير", "مستشفى الأقصى", "دقيق"]
        XCTAssertEqual(TagSuggestions.match("", history: history, excluding: [], limit: 3), ["مساعدات", "أطفال", "طوابير"])
        XCTAssertEqual(TagSuggestions.match("اطف", history: history, excluding: []), ["أطفال"])
        XCTAssertEqual(TagSuggestions.match("قصى", history: history, excluding: []), ["مستشفى الأقصى"], "contains after prefix")
        XCTAssertEqual(TagSuggestions.match("م", history: history, excluding: ["مساعدات"]), ["مستشفى الأقصى"])
        XCTAssertEqual(TagSuggestions.match("", history: history, excluding: ["اطفال"]).first, "مساعدات")
        XCTAssertFalse(TagSuggestions.match("", history: history, excluding: ["اطفال"]).contains("أطفال"), "folded match excludes")
    }

    // MARK: زرّ «أرسل N مواد»

    func testReadyDraftHasNoReason() {
        XCTAssertEqual(SendReadiness.reasons(ready(), form: .ready), [])
        XCTAssertNil(SendReadiness.firstReason(ready(), form: .ready))
    }

    func testReasonsFollowTheScreenOrder() {
        let empty = MaterialDraft()
        XCTAssertEqual(SendReadiness.reasons(empty, form: .loading),
                       [.files, .title, .type, .tags, .place, .sensitivity, .displayName, .formLoading])
        var d = ready()
        d.title = "قصير"
        d.materialTypes = []
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .title)
        d.title = "عنوان كافٍ"
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .type)
        d.materialTypes = [.report]
        d.tags = []
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .tags, "tags are required in v2 even though optional in the contract")
        d.tags = ["وسم"]
        d.city = ""
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .place)
        d.city = "النصيرات"
        XCTAssertEqual(SendReadiness.firstReason(d, form: .missingFields), .formFields)
        XCTAssertEqual(SendReadiness.firstReason(d, form: .unavailable), .formUnavailable)
    }

    /// نموذج مكتب بحقل اختياري (تحت «المزيد») قبل حقل مطلوب في ترتيب النموذج، كي يُختبر ترتيب الشاشة لا ترتيب النموذج.
    private func deskForm() -> UploadForm {
        UploadForm(version: 3, fields: [
            UploadFormField(key: "code", type: .shortText, label: UploadFormLocalized(ar: "رمز", en: "Code"), required: false,
                            validation: UploadFormValidation(minLength: 4, pattern: "^[A-Z0-9]+$")),
            UploadFormField(key: "desk_ref", type: .shortText, label: UploadFormLocalized(ar: "مرجع المكتب", en: "Desk ref"), required: true,
                            validation: UploadFormValidation(maxLength: 6)),
        ])
    }

    func testFormReasonsSayWhetherAFieldIsMissingOrInvalid() {
        let form = deskForm()
        let d = ready()
        func check(_ values: [String: FormValue]) -> SendFormCheck { SendFormCheck(form: form, materialType: "breaking", values: values) }

        let empty = check([:])
        XCTAssertEqual(empty.state, .missingFields)
        XCTAssertEqual(SendReadiness.firstReason(d, form: empty.state), .formFields)
        XCTAssertEqual(empty.first, FieldError(field: "desk_ref", code: .required))
        XCTAssertFalse(empty.firstIsUnderMore)
        XCTAssertEqual(empty.shownErrors(revealRequired: false), [], "an untouched required field is not red from the start")
        XCTAssertEqual(empty.shownErrors(revealRequired: true), [FieldError(field: "desk_ref", code: .required)])

        // كل المطلوب مملوء، وقيمة في حقل اختياري تحت «المزيد» تخالف قاعدتها: ليست «املأ الحقول المطلوبة».
        let optionalBad = check(["desk_ref": .string("A1"), "code": .string("ab")])
        XCTAssertEqual(optionalBad.state, .invalidFields)
        XCTAssertEqual(SendReadiness.firstReason(d, form: optionalBad.state), .formInvalid)
        XCTAssertEqual(optionalBad.first, FieldError(field: "code", code: .minLength))
        XCTAssertTrue(optionalBad.firstIsUnderMore, "the screen opens More before scrolling to it")
        XCTAssertEqual(optionalBad.shownErrors(revealRequired: false), [FieldError(field: "code", code: .minLength)], "a value error shows at once")

        // الاثنان معًا: الإلزامي فوق الزرّ أولًا بترتيب الشاشة، ولو جاء بعد الاختياري في النموذج.
        let both = check(["code": .string("ab")])
        XCTAssertEqual(both.errors.map(\.field), ["desk_ref", "code"])
        XCTAssertEqual(SendReadiness.firstReason(d, form: both.state), .formFields)
        XCTAssertEqual(both.shownErrors(revealRequired: false), [FieldError(field: "code", code: .minLength)])

        let requiredBad = check(["desk_ref": .string("TOO-LONG")])
        XCTAssertEqual(SendReadiness.firstReason(d, form: requiredBad.state), .formInvalid)
        XCTAssertFalse(requiredBad.firstIsUnderMore)

        let fine = check(["desk_ref": .string("A1"), "code": .string("AB12")])
        XCTAssertEqual(fine.state, .ready)
        XCTAssertNil(fine.first)
        XCTAssertNil(SendReadiness.firstReason(d, form: fine.state))

        XCTAssertTrue(SendReadiness.Reason.formFields.isFormError)
        XCTAssertTrue(SendReadiness.Reason.formInvalid.isFormError)
        XCTAssertFalse(SendReadiness.Reason.formLoading.isFormError)
        XCTAssertFalse(SendReadiness.Reason.tags.isFormError)
    }

    func testATypedTagIsCommittedOnSendOrNamedAsTheReason() {
        var d = ready()
        d.tags = []
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .tags)
        XCTAssertNil(SendReadiness.firstReason(d, form: .ready, pendingTag: " مخيم "), "a valid typed tag counts as added")
        XCTAssertTrue(MaterialTagRules.commitPending(" مخيم ", to: &d.tags))
        XCTAssertEqual(d.tags, ["مخيم"])
        XCTAssertTrue(MaterialTagRules.commitPending("مخيم", to: &d.tags), "already added: the field just clears")
        XCTAssertEqual(d.tags, ["مخيم"])

        let tooLong = String(repeating: "س", count: MaterialTagRules.maxLength + 1)
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready, pendingTag: tooLong), .pendingTag)
        XCTAssertFalse(MaterialTagRules.commitPending(tooLong, to: &d.tags))
        var empty = ready()
        empty.tags = []
        XCTAssertEqual(SendReadiness.reasons(empty, form: .ready, pendingTag: tooLong), [.pendingTag, .tags],
                       "the typed tag is named before asking for one")

        d.tags = (0..<MaterialTagRules.maxCount).map { "وسم\($0)" }
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready, pendingTag: "جديد"), .pendingTag)
        XCTAssertNil(SendReadiness.firstReason(d, form: .ready, pendingTag: "وسم3"), "a duplicate is not a reason")
    }

    func testTitleTooLongForTheSetIsItsOwnReason() {
        var d = ready()
        d.title = String(repeating: "س", count: 78)
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .titleTooLongForSet)
    }

    func testPseudonymNeedsAName() {
        var d = ready()
        d.displayMode = .pseudonym
        XCTAssertEqual(SendReadiness.reasons(d, form: .ready), [.pseudonym])
        d.pseudonym = "أبو علي"
        XCTAssertEqual(SendReadiness.reasons(d, form: .ready), [])
    }

    // MARK: سؤال الحساسية الواحد

    func testSensitivityStartsUnansweredAndNoAnswersAllThree() throws {
        var d = ready(answered: false)
        XCTAssertNil(d.sensitivityGate)
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .sensitivity)
        d.answerSensitivity(.no)
        XCTAssertEqual(d.sensitivity, Sensitivity(minors: false, injured: false, graphic: false))
        XCTAssertNil(SendReadiness.firstReason(d, form: .ready))
        XCTAssertEqual(try XCTUnwrap(DraftValidator.materialCreate(d, dynamicFields: [:])).sensitivity,
                       Sensitivity(minors: false, injured: false, graphic: false))
    }

    func testYesOpensThreeQuestionsWithNoDefaultEvenAfterNo() {
        var d = ready()
        d.answerSensitivity(.no)
        d.answerSensitivity(.yes)
        XCTAssertNil(d.minors); XCTAssertNil(d.injured); XCTAssertNil(d.graphic)
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .followups)
        d.minors = true; d.injured = false
        XCTAssertEqual(SendReadiness.firstReason(d, form: .ready), .followups, "every one of the three must be answered")
        d.graphic = false
        XCTAssertNil(SendReadiness.firstReason(d, form: .ready))
        XCTAssertEqual(d.sensitivity, Sensitivity(minors: true, injured: false, graphic: false))
    }

    func testLegacyDraftsDeriveTheGateAndDecodeWithoutTags() throws {
        XCTAssertNil(MaterialDraft.derivedGate(minors: nil, injured: nil, graphic: nil))
        XCTAssertEqual(MaterialDraft.derivedGate(minors: false, injured: false, graphic: false), .no)
        XCTAssertEqual(MaterialDraft.derivedGate(minors: false, injured: true, graphic: false), .yes)
        XCTAssertEqual(MaterialDraft.derivedGate(minors: false, injured: nil, graphic: nil), .yes, "partial answers keep asking")

        // مسودة كتبها تدفق الخطوات الأربع: الأسئلة الثلاثة مجابة مباشرة، بلا جواب واحد ولا وسوم.
        var old = ready(answered: false)
        old.minors = false; old.injured = true; old.graphic = false
        XCTAssertEqual(old.sensitivityGate, .yes)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        for key in ["tags", "sensitivityAnswer", "shotAtOverride"] { object[key] = nil }
        var files = try XCTUnwrap(object["files"] as? [[String: Any]])
        for i in files.indices { files[i]["capturedAt"] = nil }
        object["files"] = files
        let decoded = try JSONDecoder().decode(MaterialDraft.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(decoded.tags, [])
        XCTAssertEqual(decoded.sensitivityGate, .yes)
        XCTAssertNil(decoded.sensitivityAnswer)
        XCTAssertNil(decoded.shotAtOverride)
        XCTAssertNil(decoded.files[0].capturedAt)
        XCTAssertEqual(decoded.createIdempotencyKey, old.createIdempotencyKey)
        XCTAssertEqual(decoded.sensitivity, old.sensitivity)
        XCTAssertEqual(SendReadiness.reasons(decoded, form: .ready), [.tags], "its three answers are kept; only the new required tags are asked")
    }

    func testAnAnsweredGateRoundTrips() throws {
        var d = ready(answered: false)
        d.answerSensitivity(.yes)
        d.minors = false
        let decoded = try JSONDecoder().decode(MaterialDraft.self, from: JSONEncoder().encode(d))
        XCTAssertEqual(decoded, d)
        XCTAssertEqual(decoded.sensitivityAnswer, .yes)
        XCTAssertEqual(SendReadiness.firstReason(decoded, form: .ready), .followups)
    }

    func testTagsAndGateCountAsInputThatCloseMustNotLose() {
        var d = MaterialDraft()
        XCTAssertFalse(d.hasInput)
        d.tags = ["وسم"]
        XCTAssertTrue(d.hasInput)
        d = MaterialDraft()
        d.answerSensitivity(.yes)
        XCTAssertTrue(d.hasInput)
    }

    // MARK: جسم الطلب

    func testTheRequestCarriesTagsAndTheShotTime() throws {
        let shot = Date(timeIntervalSince1970: 1_790_000_000)
        var d = ready()
        d.files = [file("a.mov", capturedAt: shot)]
        d.tags = ["شتاء", "النصيرات"]
        let body = try XCTUnwrap(DraftValidator.materialCreate(d, file: d.files[0], dynamicFields: [:]))
        XCTAssertEqual(body.tags, ["شتاء", "النصيرات"])
        XCTAssertEqual(body.shotAt, shot)
        let corrected = Date(timeIntervalSince1970: 1_780_000_000)
        d.shotAtOverride = corrected
        XCTAssertEqual(DraftValidator.materialCreate(d, file: d.files[0], dynamicFields: [:])?.shotAt, corrected, "the correction wins")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: CodableHelper().jsonEncoder.encode(body)) as? [String: Any])
        XCTAssertEqual(Set(try XCTUnwrap(json["tags"] as? [String])), ["شتاء", "النصيرات"])
        XCTAssertNil(json["gps"], "no coordinates in this release")
    }

    func testRequestWithoutTagsOmitsTheField() throws {
        var d = ready()
        d.tags = []
        let body = try XCTUnwrap(DraftValidator.materialCreate(d, dynamicFields: [:]))
        XCTAssertNil(body.tags)
    }

    @MainActor func testSubmissionSendsEachFileItsOwnShotTime() async {
        let first = Date(timeIntervalSince1970: 1_790_000_000)
        var d = ready()
        d.files = [file("a.mov", capturedAt: first), file("b.mov")]
        var bodies: [MaterialCreate] = []
        let outcome = await DraftSubmission.run(d, dynamicFields: [:]) { _, body in bodies.append(body); return UUID() } enqueue: { _, _, _ in }
        XCTAssertNil(outcome.error)
        XCTAssertEqual(bodies.map(\.shotAt), [first, nil])
        XCTAssertEqual(bodies.map(\.tags), [["مساعدات"], ["مساعدات"]])
    }

    func testCaptureTimeIsReadFromExifWithItsOffset() throws {
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(CaptureDate.exif("2026:11:01 14:32:05", offset: "+02:00", timeZone: utc), Date(timeIntervalSince1970: 1_793_536_325))
        XCTAssertEqual(CaptureDate.exif("2026:11:01 14:32:05", offset: nil, timeZone: utc), Date(timeIntervalSince1970: 1_793_543_525))
        XCTAssertEqual(CaptureDate.exif("2026:11:01 14:32:05", offset: "-0530", timeZone: utc), Date(timeIntervalSince1970: 1_793_563_325))
        XCTAssertEqual(CaptureDate.exif("2026:11:01 14:32:05", offset: "bogus", timeZone: utc), Date(timeIntervalSince1970: 1_793_543_525),
                       "an unreadable offset falls back to the phone's zone")
        XCTAssertNil(CaptureDate.exif("0000:00:00 00:00:00", offset: nil))
        XCTAssertNil(CaptureDate.exif("yesterday", offset: nil))
    }

    // MARK: المكان واسم الظهور المتذكَّران

    func testThePlaceAndDisplayNameAreRememberedFromTheLastSend() {
        var memory = ReporterMemory()
        var fresh = MaterialDraft()
        memory.prefill(&fresh)
        XCTAssertEqual(fresh.governorate, "")
        XCTAssertEqual(fresh.displayMode, .realName, "real_name by default")

        memory.rememberSend(governorate: " دير البلح ", city: "النصيرات", tags: ["شتاء"])
        var next = MaterialDraft()
        memory.prefill(&next)
        XCTAssertEqual(next.governorate, "دير البلح")
        XCTAssertEqual(next.city, "النصيرات")
        XCTAssertTrue(memory.isRemembered(governorate: next.governorate, city: next.city))
        XCTAssertTrue(next.tags.isEmpty, "tags are suggested, never copied into the next send")

        var typed = MaterialDraft()
        typed.governorate = "غزة"; typed.city = "الرمال"; typed.displayMode = .network
        memory.prefill(&typed)
        XCTAssertEqual(typed.governorate, "غزة", "what the reporter typed wins")
        XCTAssertEqual(typed.displayMode, .network)

        memory.rememberSend(governorate: "", city: "", tags: [])
        XCTAssertEqual(memory.governorate, "دير البلح", "an empty place does not erase the remembered one")

        memory.displayMode = .pseudonym
        memory.pseudonym = "أبو علي"
        var pseudo = MaterialDraft()
        memory.prefill(&pseudo)
        XCTAssertEqual(pseudo.displayMode, .pseudonym)
        XCTAssertEqual(pseudo.pseudonym, "أبو علي")
    }

    func testTagHistoryIsNewestFirstWithoutFoldedDuplicatesAndCapped() {
        var memory = ReporterMemory()
        memory.rememberSend(governorate: "غزة", city: "غزة", tags: ["أطفال", "دقيق"])
        memory.rememberSend(governorate: "غزة", city: "غزة", tags: ["اطفال", "طوابير"])
        XCTAssertEqual(memory.recentTags, ["اطفال", "طوابير", "دقيق"])
        memory.rememberSend(governorate: "غزة", city: "غزة", tags: (0..<100).map { "وسم\($0)" })
        XCTAssertEqual(memory.recentTags.count, ReporterMemory.tagHistoryLimit)
        XCTAssertEqual(memory.recentTags.first, "وسم0")
    }

    func testTheMemoryFileRoundTripsAndClears() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("memory-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = ReporterMemoryStore(fileURL: dir.appendingPathComponent("reporter-memory.json"))
        XCTAssertEqual(store.load(), ReporterMemory())
        store.update { $0.rememberSend(governorate: "رفح", city: "تل السلطان", tags: ["خيام"]) }
        let reopened = ReporterMemoryStore(fileURL: store.fileURL)
        XCTAssertEqual(reopened.load().city, "تل السلطان")
        XCTAssertEqual(reopened.load().recentTags, ["خيام"])
        reopened.clear()
        XCTAssertEqual(store.load(), ReporterMemory())
        try Data("{\"city\":\"خانيونس\"}".utf8).write(to: store.fileURL)
        XCTAssertEqual(store.load().city, "خانيونس", "missing keys decode to defaults")
    }

    // MARK: دوائر البثّ والإرسالات

    private func item(_ size: Int64, _ confirmed: Int64, _ state: UploadItem.State, paused: Bool = false, preview: Bool = false) -> UploadItem {
        UploadItem(id: UUID(), materialId: UUID(), sizeBytes: size, confirmedOffset: confirmed, state: state, paused: paused, previewArrived: preview)
    }

    func testTheRingsShowTheSizeWeightedShareThatArrived() {
        XCTAssertEqual(UploadOverview.fraction([]), 0)
        XCTAssertEqual(UploadOverview.fraction([item(100, 100, .arrived), item(300, 60, .transferring)]), 0.4, accuracy: 0.0001)
        XCTAssertEqual(UploadOverview.fraction([item(100, 0, .arrived), item(100, 0, .cancelled)]), 1, "arrived counts in full, cancelled not at all")
        XCTAssertEqual(UploadOverview.fraction([item(100, 500, .transferring)]), 1, "never above one")
    }

    func testRingStateNamesWhatTheReporterSees() {
        XCTAssertEqual(UploadOverview.ringState([item(1, 0, .transferring)], online: true), .uploading)
        XCTAssertEqual(UploadOverview.ringState([item(1, 0, .transferring)], online: false), .waiting)
        XCTAssertEqual(UploadOverview.ringState([item(1, 0, .transferring, paused: true)], online: true), .waiting)
        XCTAssertEqual(UploadOverview.ringState([item(1, 1, .arrived), item(1, 0, .failed)], online: true), .failed)
        XCTAssertEqual(UploadOverview.ringState([item(1, 1, .arrived), item(1, 0, .cancelled)], online: true), .done)
    }

    func testStagesNeverClaimTheBackup() {
        XCTAssertEqual(UploadOverview.stage(item(1, 0, .transferring)), UploadStage.none)
        XCTAssertEqual(UploadOverview.stage(item(1, 0, .transferring, preview: true)), .preview)
        XCTAssertEqual(UploadOverview.stage(item(1, 1, .arrived)), .original)
        XCTAssertEqual(UploadOverview.previewCount([item(1, 1, .arrived), item(1, 0, .preparing, preview: true), item(1, 0, .preparing)]), 2)
        XCTAssertTrue(UploadOverview.isComplete([item(1, 1, .arrived), item(1, 0, .cancelled)]))
        XCTAssertFalse(UploadOverview.isComplete([item(1, 1, .arrived), item(1, 0, .failed)]))
        XCTAssertFalse(UploadOverview.isComplete([item(1, 0, .cancelled)]))
    }

    // MARK: نغمات الحالات الثلاث

    func testV2TonesFollowEachTrack() {
        XCTAssertEqual(MaterialStatus.signalTone(.good, track: .technical), .ok)
        XCTAssertEqual(MaterialStatus.signalTone(.progress, track: .technical), .muted)
        XCTAssertEqual(MaterialStatus.signalTone(.bad, track: .technical), .danger)
        XCTAssertEqual(MaterialStatus.signalTone(.neutral, track: .editorial), .warn)
        XCTAssertEqual(MaterialStatus.signalTone(.good, track: .editorial), .ok)
        XCTAssertEqual(MaterialStatus.signalTone(.bad, track: .editorial), .danger)
        XCTAssertEqual(MaterialStatus.signalTone(.neutral, track: .rights), .muted)
        XCTAssertEqual(MaterialStatus.signalTone(.good, track: .rights), .brand)
        XCTAssertEqual(MaterialStatus.signalTone(.bad, track: .rights), .warn)
    }

    // MARK: النصوص

    func testEveryReasonAndStageHasArabicAndEnglishText() throws {
        let catalog = repoRoot.appendingPathComponent("apps/ios/App/Resources/Localizable.xcstrings")
        let strings = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: catalog)) as? [String: Any])["strings"] as? [String: Any]
        let keys = SendReadiness.Reason.allCases.map(\.labelKey)
            + [UploadStage.none, .preview, .original, .backup].map(\.labelKey)
        for key in keys {
            let entry = try XCTUnwrap(strings?[key] as? [String: Any], key)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            XCTAssertNotNil(localizations["ar"], key)
            XCTAssertNotNil(localizations["en"], key)
        }
    }
}
