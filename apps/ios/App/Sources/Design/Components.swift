import MaterialsCore
import PostHistoryAPI
import SwiftUI

// مكوّنات نظام التصميم (docs/design/design-system.md §6) من الرموز المولَّدة وحدها؛ لا قيم ألوان أو مسافات مكتوبة هنا.

/// نبرة الحالة: خلفية ونص وحد من `tone/*`.
enum VLTone {
    case neutral, progress, good, attention, bad, urgent

    init(_ tone: MaterialStatus.Tone) {
        switch tone {
        case .neutral: self = .neutral
        case .progress: self = .progress
        case .good: self = .good
        case .attention: self = .attention
        case .bad: self = .bad
        }
    }

    var background: Color {
        switch self {
        case .neutral: return .vl.toneNeutralBg
        case .progress: return .vl.toneProgressBg
        case .good: return .vl.toneGoodBg
        case .attention: return .vl.toneAttentionBg
        case .bad: return .vl.toneBadBg
        case .urgent: return .vl.toneUrgentBg
        }
    }

    var foreground: Color {
        switch self {
        case .neutral: return .vl.toneNeutralFg
        case .progress: return .vl.toneProgressFg
        case .good: return .vl.toneGoodFg
        case .attention: return .vl.toneAttentionFg
        case .bad: return .vl.toneBadFg
        case .urgent: return .vl.toneUrgentFg
        }
    }

    var border: Color {
        switch self {
        case .neutral: return .vl.toneNeutralBorder
        case .progress: return .vl.toneProgressBorder
        case .good: return .vl.toneGoodBorder
        case .attention: return .vl.toneAttentionBorder
        case .bad: return .vl.toneBadBorder
        case .urgent: return .vl.toneUrgentBorder
        }
    }
}

/// مسارات المادة الثلاثة: أيقونة ولون مستقلان لكل مسار (لا تعتمد الحالة على اللون وحده).
enum VLTrack: String, CaseIterable, Identifiable {
    case technical, editorial, rights
    var id: String { rawValue }

    var accent: Color {
        switch self {
        case .technical: return .vl.trackTechnicalAccent
        case .editorial: return .vl.trackEditorialAccent
        case .rights: return .vl.trackRightsAccent
        }
    }

    var subtle: Color {
        switch self {
        case .technical: return .vl.trackTechnicalSubtle
        case .editorial: return .vl.trackEditorialSubtle
        case .rights: return .vl.trackRightsSubtle
        }
    }

    var systemImage: String {
        switch self {
        case .technical: return "film"
        case .editorial: return "pencil"
        case .rights: return "scale.3d"
        }
    }

    /// «الحالة الفنية» وأخواتها: بادئة قارئ الشاشة لكل شارة.
    var labelKey: String { "track.\(rawValue)" }

    init?(_ track: TransitionRecord.Track) {
        switch track {
        case .technical: self = .technical
        case .editorial: self = .editorial
        case .rights: self = .rights
        default: return nil
        }
    }
}

struct VLCard<Content: View>: View {
    var border: Color = .vl.borderDefault
    var background: Color = .vl.bgSurface
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s4) { content }
            .padding(VL.Space.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: RoundedRectangle(cornerRadius: VL.Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.lg).strokeBorder(border, lineWidth: VL.Border.hairline))
    }
}

struct VLPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .vlText(.labelLg)
            .frame(maxWidth: .infinity, minHeight: VL.Size.controlMd)
            .padding(.horizontal, VL.Space.s5)
            .foregroundStyle(isEnabled ? Color.vl.textOnBrand : Color.vl.textDisabled)
            .background(isEnabled ? (configuration.isPressed ? Color.vl.bgBrandHover : Color.vl.bgBrand) : Color.vl.bgDisabled,
                        in: RoundedRectangle(cornerRadius: VL.Radius.md))
            .contentShape(Rectangle())
    }
}

struct VLSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        // الدور المدمّر (`role: .destructive`) يأخذ لون الخطر وحده؛ لا يُستعمل الأحمر للزخرفة.
        let destructive = configuration.role == .destructive
        return configuration.label
            .vlText(.labelLg)
            .frame(maxWidth: .infinity, minHeight: VL.Size.controlMd)
            .padding(.horizontal, VL.Space.s5)
            .foregroundStyle(isEnabled ? (destructive ? Color.vl.textDanger : Color.vl.textPrimary) : Color.vl.textDisabled)
            .background(configuration.isPressed ? Color.vl.bgSubtle : Color.vl.bgSurface, in: RoundedRectangle(cornerRadius: VL.Radius.md))
            .overlay(RoundedRectangle(cornerRadius: VL.Radius.md)
                .strokeBorder(destructive ? Color.vl.borderDanger : Color.vl.borderStrong, lineWidth: VL.Border.hairline))
            .contentShape(Rectangle())
    }
}

struct VLGhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .vlText(.labelLg)
            .frame(minHeight: VL.Size.touchMin)
            .padding(.horizontal, VL.Space.s3)
            .foregroundStyle(Color.vl.textBrand)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == VLPrimaryButtonStyle { static var vlPrimary: VLPrimaryButtonStyle { VLPrimaryButtonStyle() } }
extension ButtonStyle where Self == VLSecondaryButtonStyle { static var vlSecondary: VLSecondaryButtonStyle { VLSecondaryButtonStyle() } }
extension ButtonStyle where Self == VLGhostButtonStyle { static var vlGhost: VLGhostButtonStyle { VLGhostButtonStyle() } }

/// شارة حالة بنبرة وأيقونة مسار اختيارية؛ قارئ الشاشة يقرأ «الحالة الفنية: تم التحقق».
struct StateBadge: View {
    let labelKey: String
    let tone: VLTone
    var track: VLTrack?

    var body: some View {
        HStack(spacing: VL.Space.s2) {
            if let track { Image(systemName: track.systemImage).imageScale(.small) }
            Text(LocalizedStringKey(labelKey))
        }
        .vlText(.labelSm)
        .padding(.horizontal, VL.Space.s3)
        .padding(.vertical, VL.Space.s2)
        .foregroundStyle(tone.foreground)
        .background(tone.background, in: Capsule())
        .overlay(Capsule().strokeBorder(tone.border, lineWidth: VL.Border.hairline))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }

    private var accessibility: Text {
        guard let track else { return Text(LocalizedStringKey(labelKey)) }
        return Text(LocalizedStringKey(track.labelKey)) + Text(verbatim: ": ") + Text(LocalizedStringKey(labelKey))
    }
}

struct PriorityBadge: View {
    let priority: Priority

    var body: some View {
        StateBadge(labelKey: "material.priority." + priority.rawValue, tone: Self.tone(priority))
    }

    static func tone(_ p: Priority) -> VLTone {
        switch p {
        case .urgent: return .urgent
        case .important: return .attention
        default: return .neutral
        }
    }
}

/// الشارات الثلاث مستقلة بالترتيب فنية → تحريرية → حقوق؛ تلتف ولا تُقصّ.
struct ThreeStateBadges: View {
    let status: MaterialStatus
    var onSelect: ((VLTrack) -> Void)?

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: VL.Space.s3) { badges }
            VStack(alignment: .leading, spacing: VL.Space.s3) { badges }
        }
    }

    @ViewBuilder private var badges: some View {
        badge(.technical, status.technical)
        badge(.editorial, status.editorial)
        badge(.rights, status.rights)
    }

    @ViewBuilder private func badge(_ track: VLTrack, _ b: MaterialStatus.Badge) -> some View {
        let view = StateBadge(labelKey: b.labelKey, tone: VLTone(b.tone), track: track)
        if let onSelect {
            Button { onSelect(track) } label: { view }.buttonStyle(.plain)
                .accessibilityHint(Text("timeline.filter.hint"))
        } else {
            view
        }
    }
}

/// مؤشر الخطوات: شرائط بعدد الخطوات، المكتمل بلون العلامة، وتحتها «الخطوة n من m · الاسم».
struct VLStepper: View {
    let step: Int
    let total: Int
    let titleKey: String

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            HStack(spacing: VL.Space.s3) {
                ForEach(1...total, id: \.self) { i in
                    Capsule().fill(i <= step ? Color.vl.bgBrand : Color.vl.borderDefault).frame(height: VL.Space.s2)
                }
            }
            Text("stepper.position \(step) \(total) \(Text(LocalizedStringKey(titleKey)))")
                .vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// أزرار مقسّمة بلا قيمة افتراضية (`nil` = لم يُجب)؛ قارئ الشاشة يعاملها مجموعة اختيار واحد.
struct VLSegmented<Value: Hashable>: View {
    let options: [(value: Value, labelKey: String)]
    @Binding var selection: Value?
    var tone: (Value) -> VLTone = { _ in .progress }

    var body: some View {
        HStack(spacing: VL.Space.s2) {
            ForEach(options, id: \.value) { option in
                let selected = selection == option.value
                Button { selection = option.value } label: {
                    Text(LocalizedStringKey(option.labelKey))
                        .vlText(.labelMd)
                        .frame(maxWidth: .infinity, minHeight: VL.Size.touchMin)
                        .foregroundStyle(selected ? tone(option.value).foreground : Color.vl.textPrimary)
                        .background(selected ? tone(option.value).background : Color.vl.bgSurface, in: RoundedRectangle(cornerRadius: VL.Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: VL.Radius.md)
                            .strokeBorder(selected ? tone(option.value).border : Color.vl.borderDefault, lineWidth: selected ? VL.Border.regular : VL.Border.hairline))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// رقائق اختيار متعدد.
struct VLChips<Value: Hashable>: View {
    let options: [(value: Value, labelKey: String)]
    @Binding var selection: Set<Value>

    var body: some View {
        VLFlow(spacing: VL.Space.s3) {
            ForEach(options, id: \.value) { option in
                let selected = selection.contains(option.value)
                Button {
                    if selected { selection.remove(option.value) } else { selection.insert(option.value) }
                } label: {
                    HStack(spacing: VL.Space.s2) {
                        if selected { Image(systemName: "checkmark").imageScale(.small) }
                        Text(LocalizedStringKey(option.labelKey))
                    }
                    .vlText(.labelMd)
                    .padding(.horizontal, VL.Space.s4)
                    .frame(minHeight: VL.Size.touchMin)
                    .foregroundStyle(selected ? Color.vl.textOnBrand : Color.vl.textPrimary)
                    .background(selected ? Color.vl.bgBrand : Color.vl.bgSurface, in: Capsule())
                    .overlay(Capsule().strokeBorder(selected ? Color.clear : Color.vl.borderDefault, lineWidth: VL.Border.hairline))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
    }
}

/// تخطيط يلفّ العناصر إلى أسطر (رقائق وشارات).
struct VLFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width { rows.append(Row()) }
            var row = rows[rows.count - 1]
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

/// تنبيه داخلي بنبرة وأيقونة ونص، مع إجراء اختياري.
struct VLInlineAlert: View {
    let tone: VLTone
    let systemImage: String
    let textKey: String
    var actionKey: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s3) {
            Label { Text(LocalizedStringKey(textKey)).vlText(.bodySm) } icon: { Image(systemName: systemImage) }
                .foregroundStyle(tone.foreground)
            if let actionKey, let action {
                Button(LocalizedStringKey(actionKey), action: action).buttonStyle(.vlSecondary)
            }
        }
        .padding(VL.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.background, in: RoundedRectangle(cornerRadius: VL.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: VL.Radius.md).strokeBorder(tone.border, lineWidth: VL.Border.hairline))
    }
}

/// عنوان قسم صغير بالأحرف الكبيرة (`overline/md`).
struct VLOverline: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(LocalizedStringKey(text)).vlText(.overlineMd).foregroundStyle(Color.vl.textSecondary).textCase(.uppercase)
    }
}

/// صندوق حقل الإدخال كما في مكوّن Form Field في Figma: ارتفاع `control-md`، سطح `bg/surface`، حد `border/strong` (1)،
/// وعند التركيز `border/focus` (2) مع حلقة التركيز، وعند الخطأ `border/danger` (2). نص القيمة `body/md` (16).
private struct VLInputBox: ViewModifier {
    var invalid: Bool
    @Environment(\.isEnabled) private var isEnabled
    @FocusState private var focused: Bool

    private var borderColor: Color {
        if invalid { return .vl.borderDanger }
        return focused ? .vl.borderFocus : .vl.borderStrong
    }

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: VL.Radius.md)
        return content
            .vlText(.bodyMd)
            .foregroundStyle(isEnabled ? Color.vl.textPrimary : Color.vl.textDisabled)
            .focused($focused)
            .padding(.horizontal, VL.Space.s4)
            .padding(.vertical, VL.Space.s3)
            .frame(maxWidth: .infinity, minHeight: VL.Size.controlMd, alignment: .leading)
            .background(isEnabled ? Color.vl.bgSurface : Color.vl.bgDisabled, in: shape)
            .overlay(shape.strokeBorder(borderColor, lineWidth: invalid || focused ? VL.Border.regular : VL.Border.hairline))
            .overlay {
                if focused { shape.stroke(Color.vl.borderFocus.opacity(0.3), lineWidth: VL.Border.emphasis).padding(-VL.Border.emphasis) }
            }
            .contentShape(shape)
            .onTapGesture { focused = true }
    }
}

extension View {
    /// يلبس حقل نص (`TextField` / `SecureField`) صندوق Form Field؛ يُستعمل داخل `VLField` أو منفردًا.
    func vlInput(invalid: Bool = false) -> some View { modifier(VLInputBox(invalid: invalid)) }
}

/// حقل بعنوان فوقه، فعلامة «مطلوب» أو «اختياري»، ونص مساعد تحته. رسالة الخطأ تستبدل نص المساعدة ولا تُضاف إليه (المواصفة §6).
/// العنوان المرئي مخفي عن قارئ الشاشة، وعنوان العنصر لقارئ الشاشة هو `a11yLabel` (يساوي العنوان المرئي افتراضيًا).
struct VLField<Content: View>: View {
    let label: Text
    var a11yLabel: Text?
    var isRequired = false
    var isOptional = false
    var help: Text?
    var error: Text?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            HStack(spacing: VL.Space.s3) {
                label.vlText(.labelMd).foregroundStyle(error == nil ? Color.vl.textPrimary : Color.vl.textDanger)
                if isRequired { Text(verbatim: "*").vlText(.labelMd).foregroundStyle(Color.vl.textDanger) }
                if isOptional { Text("form.optional").vlText(.captionMd).foregroundStyle(Color.vl.textMuted) }
            }
            .accessibilityHidden(true)
            content
                .vlInput(invalid: error != nil)
                .accessibilityLabel(a11yLabel ?? label)
            if let error {
                error.vlText(.captionMd).foregroundStyle(Color.vl.textDanger)
            } else if let help {
                help.vlText(.captionMd).foregroundStyle(Color.vl.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// تنبيه كما في مكوّن Alert في Figma: سطح أبيض وحد 1px، والنبرة تحملها الأيقونة والنص لا الخلفية.
/// (`VLInlineAlert` أعلاه يلوّن الخلفية بالنبرة ويبقى للشاشات المنفَّذة سابقًا.)
struct VLAlert: View {
    let tone: VLTone
    let systemImage: String
    let text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: VL.Space.s4) {
            Image(systemName: systemImage).imageScale(.large).foregroundStyle(tone.foreground).accessibilityHidden(true)
            Text(text).vlText(.labelLg).foregroundStyle(tone.foreground).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, VL.Space.s5)
        .padding(.vertical, VL.Space.s4)
        .background(Color.vl.bgSurface, in: RoundedRectangle(cornerRadius: VL.Radius.md))
        .overlay(RoundedRectangle(cornerRadius: VL.Radius.md).strokeBorder(Color.vl.borderDefault, lineWidth: VL.Border.hairline))
        .accessibilityElement(children: .combine)
    }
}

/// رأس العلامة في شاشة الدخول: شريط داكن (`bg/slate`) باسم التطبيق بخط العرض، على نمط الشريط العلوي في إطارات الهاتف.
struct VLBrandHeader: View {
    let nameKey: LocalizedStringKey

    var body: some View {
        Text(nameKey)
            .vlText(.displayMd)
            .foregroundStyle(Color.vl.textOnSlate)
            .lineLimit(2)
            .minimumScaleFactor(0.7)
            .padding(.horizontal, VL.Space.s5)
            .padding(.vertical, VL.Space.s7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.vl.bgSlate.ignoresSafeArea(edges: .top))
    }
}

/// دائرة أيقونة بنبرة لشاشات الحالة الكاملة (قفل، إبطال الجلسة، المسح)؛ زخرفية فلا يقرؤها قارئ الشاشة.
struct VLHeroIcon: View {
    let systemImage: String
    let tone: VLTone

    var body: some View {
        ZStack {
            Circle().fill(tone.background)
            Circle().strokeBorder(tone.border, lineWidth: VL.Border.regular)
            Image(systemName: systemImage).font(.system(size: VL.Space.s9, weight: .semibold)).foregroundStyle(tone.foreground)
        }
        .frame(width: VL.Space.s12 + VL.Space.s3, height: VL.Space.s12 + VL.Space.s3)
        .accessibilityHidden(true)
    }
}

extension View {
    /// خلفية الشاشة وعرض أقصى 560 على الشاشات العريضة (المواصفة §3).
    func vlScreen() -> some View {
        frame(maxWidth: 560).frame(maxWidth: .infinity).background(Color.vl.bgCanvas.ignoresSafeArea())
    }
}
