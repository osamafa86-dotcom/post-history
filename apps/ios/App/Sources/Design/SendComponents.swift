import MaterialsCore
import PostHistoryAPI
import SwiftUI

// مكوّنات شاشة الإرسال الواحدة (04 في reporter-v2.md، وdesign-system-v2.md «المكوّنات»).

// MARK: - عنوان التغطية

/// `Text field` لعنوان التغطية بعدّاد LTR بأرقام Rubik الجدولية. الحدّ المعروض ينقص منه لاحقة ` (i/N)` حين تكون الملفات أكثر من
/// واحد (ADR 0081)، والعدّ بنقاط الترميز كما يعدّها الخادم. السطر الجديد لا يدخل العنوان.
struct TitleField: View {
    @Binding var title: String
    let fileCount: Int
    var showsError = false
    @FocusState.Binding var focused: Bool

    private var count: Int { DraftValidator.titleLength(title) }
    private var limit: Int { DraftValidator.titleLimit(forFileCount: fileCount) }
    private var over: Bool { count > limit }

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            VLFieldLabel(text: Text("send.field.title")).accessibilityHidden(true)
            HStack(alignment: .lastTextBaseline, spacing: VL.Space.s3) {
                TextField(text: Binding(get: { title }, set: { title = $0.replacingOccurrences(of: "\n", with: " ") }),
                          prompt: Text("send.title.placeholder").foregroundStyle(Color.vl.textSecondary), axis: .vertical) {
                    Text("send.field.title")
                }
                .vlText(.headline)
                .foregroundStyle(Color.vl.textPrimary)
                .lineLimit(1...4)
                .submitLabel(.next)
                .focused($focused)
                Text(verbatim: "\(count)/\(limit)")
                    .vlText(.caption)
                    .monospacedDigit()
                    .foregroundStyle(over ? Color.vl.priorityUrgent : Color.vl.textSecondary)
                    .environment(\.layoutDirection, .leftToRight)
                    .accessibilityLabel(Text("send.title.counter \(count) \(limit)"))
            }
            .padding(.horizontal, VL.Space.s4)
            .padding(.vertical, VL.Space.s3)
            .frame(maxWidth: .infinity, minHeight: VL.Size.fieldMin, alignment: .leading)
            .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous)
                .strokeBorder(showsError || over ? Color.vl.stateDanger : (focused ? Color.vl.actionPrimary : Color.vl.borderEdge),
                              lineWidth: focused || showsError || over ? VL.Border.field + 0.5 : VL.Border.field))
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
            if over {
                VLFieldError(text: Text(LocalizedStringKey(DraftValidator.Issue.titleTooLongForSet.labelKey)))
            }
        }
    }
}

// MARK: - نوع التغطية

/// `material_types[]` رقاقاتٍ باختيار متعدد. تظهر الأربعة الأولى، والباقي تحت «المزيد» (ويظهر وحده إن اختير منه شيء).
struct CoverageTypePicker: View {
    @Binding var selection: Set<MaterialType>
    @State private var expanded = false

    static let primary: [MaterialType] = [.breaking, .report, .interview, .rawFootage]
    static let more: [MaterialType] = [.aerial, .pressConference, .eyewitness, .photos]

    private var shown: [MaterialType] {
        expanded || !selection.isDisjoint(with: Self.more) ? Self.primary + Self.more : Self.primary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            VLFieldLabel(text: Text("send.field.type")).accessibilityHidden(true)
            VLFlow(spacing: VL.Space.s3) {
                ForEach(shown, id: \.self) { type in
                    VLChip(label: Text(LocalizedStringKey("coverage.type." + type.rawValue)), selected: selection.contains(type)) {
                        if selection.contains(type) { selection.remove(type) } else { selection.insert(type) }
                    }
                }
                if shown.count == Self.primary.count {
                    VLChip(label: Text("send.type.more"), selected: false) { expanded = true }
                        .accessibilityHint(Text("send.type.more.hint"))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("send.field.type"))
        }
    }
}

// MARK: - الوسوم

/// `Tag input`: وسوم المراسل رقاقاتٍ بزرّ إزالة (هدف لمس كامل)، وحقل يضيف بالفاصلة أو «تم» أو مغادرة الحقل، واقتراحات من
/// وسومه السابقة على هاتفه (قائمة الإدارة تأتي بطلب عقد لاحق، ADR 0086). كل وسم يُطبَّع ويُتحقق منه بقاعدة العقد قبل إضافته،
/// وما لم يُضَف يُقال سببه. يلتفّ ولا يدفع «أرسل» خارج الشاشة.
struct TagInput: View {
    @Binding var tags: [String]
    let history: [String]
    var showsError = false
    @FocusState.Binding var focused: Bool

    @State private var text = ""
    @State private var problem: MaterialTagRules.AddResult?

    private var suggestions: [String] { TagSuggestions.match(text, history: history, excluding: tags) }

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            VLFieldLabel(text: Text("send.field.tags")).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                if !tags.isEmpty {
                    VLFlow(spacing: VL.Space.s3) {
                        ForEach(tags, id: \.self) { tag in chip(tag) }
                    }
                }
                HStack(spacing: VL.Space.s3) {
                    Image(systemName: "plus").foregroundStyle(Color.vl.textSecondary).accessibilityHidden(true)
                    TextField(text: $text, prompt: Text("send.tags.add").foregroundStyle(Color.vl.textSecondary)) { Text("send.field.tags") }
                        .vlText(.body)
                        .foregroundStyle(Color.vl.textPrimary)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($focused)
                        .onSubmit { commit(text); text = ""; focused = true }
                        .onChange(of: text) { _, new in
                            let parts = MaterialTagRules.split(new)
                            guard !parts.complete.isEmpty else { return }
                            for part in parts.complete { commit(part) }
                            text = parts.remainder
                        }
                        .onChange(of: focused) { _, isFocused in
                            if !isFocused, !text.isEmpty { commit(text); text = "" }
                        }
                        .accessibilityHint(Text("send.tags.hint"))
                }
                .frame(minHeight: VL.Size.touchMin)
            }
            .padding(VL.Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous)
                .strokeBorder(showsError ? Color.vl.stateDanger : (focused ? Color.vl.actionPrimary : Color.vl.borderEdge),
                              lineWidth: focused || showsError ? VL.Border.field + 0.5 : VL.Border.field))
            if let problem, let key = Self.problemKey(problem) {
                VLFieldError(text: Text(key))
            }
            if !suggestions.isEmpty, tags.count < MaterialTagRules.maxCount {
                VLFlow(spacing: VL.Space.s3) {
                    Text("send.tags.recent").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                        .frame(minHeight: VL.Size.touchMin)
                    ForEach(suggestions, id: \.self) { suggestion in
                        Button { commit(suggestion); text = "" } label: {
                            Text(verbatim: suggestion)
                                .vlText(.chip)
                                .foregroundStyle(Color.vl.textPrimary)
                                .padding(.horizontal, VL.Space.s4)
                                .frame(minHeight: VL.Size.touchMin)
                                .overlay(RoundedRectangle(cornerRadius: VL.Radius.chip, style: .continuous)
                                    .strokeBorder(Color.vl.borderEdge, style: StrokeStyle(lineWidth: VL.Border.hairline, dash: [4, 3])))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("send.tags.suggestion \(suggestion)"))
                    }
                }
            }
        }
    }

    /// `Tag / Removable`: النص بلا قصّ (يلتفّ)، وزرّ الإزالة 44×44.
    private func chip(_ tag: String) -> some View {
        HStack(spacing: 0) {
            Text(verbatim: tag)
                .vlText(.chip)
                .foregroundStyle(Color.vl.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, VL.Space.s4)
            Button { tags.removeAll { $0 == tag }; problem = nil } label: {
                Image(systemName: "xmark").imageScale(.small).foregroundStyle(Color.vl.textSecondary)
                    .frame(width: VL.Size.touchMin, height: VL.Size.touchMin)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("send.tags.remove \(tag)"))
        }
        .background(Color.vl.bgSunken, in: RoundedRectangle(cornerRadius: VL.Radius.chip, style: .continuous))
    }

    private func commit(_ raw: String) {
        let result = MaterialTagRules.add(raw, to: &tags)
        switch result {
        case .added, .empty: problem = nil
        default: problem = result
        }
    }

    static func problemKey(_ result: MaterialTagRules.AddResult) -> LocalizedStringKey? {
        switch result {
        case .tooLong: return "send.tags.error.tooLong \(MaterialTagRules.maxLength)"
        case .duplicate: return "send.tags.error.duplicate"
        case .limitReached: return "send.tags.error.limit \(MaterialTagRules.maxCount)"
        case .added, .empty: return nil
        }
    }
}

// MARK: - المكان والعاجل

/// `Location chip`: المحافظة والمدينة المتذكَّرتان من آخر إرسال، ولمسة تغيّرهما. لا إحداثيات أبدًا.
struct LocationChip: View {
    let governorate: String
    let city: String
    let remembered: Bool
    var showsError = false
    let action: () -> Void

    private var empty: Bool { governorate.isEmpty || city.isEmpty }

    var body: some View {
        Button(action: action) {
            HStack(spacing: VL.Space.s3) {
                Image(systemName: "mappin.and.ellipse")
                    .foregroundStyle(empty ? Color.vl.textBrand : Color.vl.textPrimary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: VL.Space.s1) {
                    if empty {
                        Text("send.place.add").vlText(.headline).foregroundStyle(Color.vl.textBrand)
                        Text("send.place.addHint").vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                    } else {
                        Text(verbatim: "\(governorate) · \(city)").vlText(.headline).foregroundStyle(Color.vl.textPrimary)
                        Text(LocalizedStringKey(remembered ? "send.place.remembered" : "send.place.edit")).vlText(.caption).foregroundStyle(Color.vl.textSecondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .padding(.horizontal, VL.Space.s4)
            .padding(.vertical, VL.Space.s3)
            .frame(maxWidth: .infinity, minHeight: VL.Size.ctaMin, alignment: .leading)
            .background(Color.vl.bgSunken, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
            .overlay {
                if showsError {
                    RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous).strokeBorder(Color.vl.stateDanger, lineWidth: VL.Border.field)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(empty ? Text("send.place.add") : Text(verbatim: "\(governorate) · \(city)"))
        .accessibilityHint(Text("send.place.hint"))
    }
}

/// `Urgent toggle`: الافتراض «عادي»، والمفعّل مملوء بلون العاجل. مفتاح لقارئ الشاشة لا لون وحده.
struct UrgentToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            VStack(spacing: VL.Space.s1) {
                Image(systemName: isOn ? "bolt.fill" : "bolt")
                Text("send.urgent").vlText(.headline)
            }
            .foregroundStyle(isOn ? Color.vl.bgRaised : Color.vl.priorityUrgent)
            .padding(.horizontal, VL.Space.s4)
            .frame(minWidth: 84, minHeight: VL.Size.ctaMin)
            .background(isOn ? Color.vl.priorityUrgent : Color.vl.bgRaised, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous).strokeBorder(Color.vl.priorityUrgent, lineWidth: VL.Border.field))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("send.urgent"))
        .accessibilityValue(Text(LocalizedStringKey(isOn ? "a11y.on" : "a11y.off")))
        .accessibilityAddTraits(isOn ? [.isToggle, .isSelected] : [.isToggle])
    }
}

// MARK: - سؤال الحساسية

/// `Sensitivity question`: سؤال واحد بصياغة الخطة، في صندوق ذهبي بإطار واضح، بلا جواب مسبق ولا يُتجاوز.
/// «لا» = الثلاثة `false`؛ «نعم» تفتح ثلاثة أسئلة صريحة، لكلٍّ «لا/نعم» بلا اختيار مسبق. كل سؤال مجموعة باسمها.
struct SensitivityQuestion: View {
    @Binding var draft: MaterialDraft
    var showsError = false

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            Label { Text("send.sensitivity.q").vlText(.headline) } icon: { Image(systemName: "shield") }
                .foregroundStyle(Color.vl.textPrimary)
                .accessibilityAddTraits(.isHeader)
            answers(selected: draft.sensitivityGate.map { $0 == .yes }) { yes in
                draft.answerSensitivity(yes ? .yes : .no)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("send.sensitivity.q"))
            if draft.sensitivityGate == nil {
                Text("send.sensitivity.hint").vlText(.caption).foregroundStyle(Color.vl.textPrimary)
            }
            if draft.sensitivityGate == .yes {
                followup("send.sensitivity.minors", draft.minors) { draft.minors = $0 }
                followup("send.sensitivity.injured", draft.injured) { draft.injured = $0 }
                followup("send.sensitivity.graphic", draft.graphic) { draft.graphic = $0 }
            }
        }
        .padding(VL.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.vl.sensitivityBg, in: RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: VL.Radius.md, style: .continuous)
            .strokeBorder(showsError ? Color.vl.stateDanger : Color.vl.sensitivityBorder, lineWidth: showsError ? VL.Border.field + 0.5 : VL.Border.field))
    }

    /// «لا» ثم «نعم» بلا اختيار مسبق (`nil`).
    private func answers(selected: Bool?, set: @escaping (Bool) -> Void) -> some View {
        HStack(spacing: VL.Space.s3) {
            VLChip(label: Text("a1.no"), selected: selected == false, minWidth: 72) { set(false) }
            VLChip(label: Text("a1.yes"), selected: selected == true, minWidth: 72) { set(true) }
        }
    }

    /// سؤال تابع: النص ثم الجوابان، ويُكدَّسان رأسيًا حين لا يتسعان (الخط الكبير).
    private func followup(_ key: LocalizedStringKey, _ value: Bool?, set: @escaping (Bool) -> Void) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: VL.Space.s3) {
                Text(key).vlText(.body).foregroundStyle(Color.vl.textPrimary)
                Spacer(minLength: VL.Space.s3)
                answers(selected: value, set: set)
            }
            VStack(alignment: .leading, spacing: VL.Space.s2) {
                Text(key).vlText(.body).foregroundStyle(Color.vl.textPrimary)
                answers(selected: value, set: set)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(key))
        .accessibilityValue(Text(LocalizedStringKey(value == nil ? "a1.required" : (value == true ? "a1.yes" : "a1.no"))))
    }
}
