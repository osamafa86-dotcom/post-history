import FormEngine
import PostHistoryAPI
import SwiftUI
import UniformTypeIdentifiers

/// راسم النموذج الديناميكي من `UploadForm` (مخطط upload-form.json): الأنواع العشرة، الرؤية بالشرط ونوع المادة، والأخطاء بالدلالات المشتركة.
struct DynamicFormView: View {
    let form: UploadForm
    let materialType: String
    @Binding var values: [String: FormValue]
    let errors: [FieldError]

    private var isArabic: Bool { Locale.current.language.languageCode?.identifier == "ar" }
    private func text(_ l: UploadFormLocalized) -> String { isArabic ? l.ar : l.en }

    var body: some View {
        ForEach(FormValidator.visibleFields(form: form, materialType: materialType, values: values), id: \.key) { field in
            FieldControl(field: field, label: text(field.label), optionLabel: text, help: field.help.map(text),
                         errorKey: errors.first(where: { $0.field == field.key })?.code.labelKey, value: binding(field.key))
        }
    }

    private func binding(_ key: String) -> Binding<FormValue> {
        Binding(get: { values[key] ?? .null }, set: { values[key] = $0 })
    }
}

/// حقل واحد بمكوّنات نظام التصميم: حقول النص والقوائم داخل `VLField` (Form Field)، والبقية بعنوان وسطر مساعد.
/// رسالة الخطأ تستبدل نص المساعدة (docs/design/design-system.md §6). عنوان قارئ الشاشة كما كان: «العنوان *» للمطلوب.
private struct FieldControl: View {
    let field: UploadFormField
    let label: String
    let optionLabel: (UploadFormLocalized) -> String
    let help: String?
    let errorKey: LocalizedStringKey?
    @Binding var value: FormValue
    @State private var showAttachmentPicker = false

    private var title: Text { Text(label) + (field.required ? Text(" *").foregroundColor(Color.vl.textDanger) : Text("")) }
    private var a11yTitle: Text { Text(verbatim: field.required ? label + " *" : label) }
    private var helpText: Text? { help.map { Text(verbatim: $0) } }
    private var errorText: Text? { errorKey.map { Text($0) } }
    private var options: [UploadFormOption] { field.validation?.options ?? [] }

    var body: some View {
        switch field.type {
        case .shortText:
            boxed { TextField(text: stringBinding, prompt: Text(verbatim: "")) { a11yTitle } }
        case .longText:
            boxed { TextField(text: stringBinding, prompt: Text(verbatim: ""), axis: .vertical) { a11yTitle }.lineLimit(3...8) }
        case .number:
            boxed { TextField(text: numberBinding, prompt: Text(verbatim: "")) { a11yTitle }.keyboardType(.decimalPad) }
        case .select:
            boxed { selectMenu }
        case .multiSelect:
            plain {
                titleRow
                ForEach(options, id: \.value) { option in
                    Toggle(isOn: multiBinding(option.value)) { Text(verbatim: optionLabel(option.label)) }
                        .vlText(.bodyMd).foregroundStyle(Color.vl.textPrimary)
                }
            }
        case .datetime:
            boxed { DatePicker(selection: dateBinding) { a11yTitle }.labelsHidden() }
        case .boolean:
            plain {
                Toggle(isOn: Binding(get: { value.boolValue ?? false }, set: { value = .bool($0) })) { title.vlText(.labelMd) }
                    .foregroundStyle(Color.vl.textPrimary)
            }
        case .staffMember:
            boxed { TextField(text: stringBinding, prompt: Text(verbatim: "")) { a11yTitle }.textInputAutocapitalization(.never).autocorrectionDisabled() }
        case .attachment:
            // قيمة التحقق `[{mime, size_bytes}]`؛ الشكل النهائي لإرسال ملفات المرفق في dynamic_fields من اختصاص العقد.
            plain {
                HStack {
                    title.vlText(.labelMd).foregroundStyle(Color.vl.textPrimary)
                    Spacer()
                    Button("form.attachment.add") { showAttachmentPicker = true }.buttonStyle(.vlGhost)
                }
                Text("form.attachment.count \(value.arrayValue?.count ?? 0)").vlText(.captionMd).foregroundStyle(Color.vl.textSecondary)
                    .fileImporter(isPresented: $showAttachmentPicker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                        guard case .success(let urls) = result else { return }
                        var items = value.arrayValue ?? []
                        for url in urls {
                            let scoped = url.startAccessingSecurityScopedResource()
                            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.doubleValue ?? 0
                            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                            items.append(.object(["mime": .string(mime), "size_bytes": .number(size)]))
                        }
                        value = .array(items)
                    }
            }
        case .location, .unknownDefaultOpenApi:
            // غير مسموح في نماذج v0 (بوابة الخادم)؛ نوع تفاعل جديد يحتاج إصدارًا من التطبيق.
            plain { Label("form.field.unsupported", systemImage: "lock").vlText(.bodySm).foregroundStyle(Color.vl.textSecondary) }
        }
    }

    private func boxed<C: View>(@ViewBuilder _ control: @escaping () -> C) -> some View {
        VLField(label: Text(verbatim: label), a11yLabel: a11yTitle, isRequired: field.required, help: helpText, error: errorText) { control() }
    }

    private func plain<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: VL.Space.s2) {
            content()
            if let errorText {
                errorText.vlText(.captionMd).foregroundStyle(Color.vl.textDanger)
            } else if let helpText {
                helpText.vlText(.captionMd).foregroundStyle(Color.vl.textMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// عنوان مرئي لمجموعة اختيارات؛ عنصر واحد لقارئ الشاشة («العنوان *»).
    private var titleRow: some View {
        title.vlText(.labelMd).foregroundStyle(errorKey == nil ? Color.vl.textPrimary : Color.vl.textDanger)
    }

    /// قائمة منسدلة بعرض الحقل كله (منطقة اللمس هي الصندوق)؛ الخيار «لا شيء» أولًا ثم خيارات النموذج.
    private var selectMenu: some View {
        let selected = options.first { $0.value == (value.stringValue ?? "") }
        let shown: Text = selected.map { Text(verbatim: optionLabel($0.label)) } ?? Text("form.select.none")
        return Menu {
            Picker(selection: stringBinding) {
                Text("form.select.none").tag("")
                ForEach(options, id: \.value) { Text(optionLabel($0.label)).tag($0.value) }
            } label: { a11yTitle }
        } label: {
            HStack(spacing: VL.Space.s3) {
                shown.foregroundStyle(Color.vl.textPrimary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(Color.vl.iconDefault).accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .accessibilityValue(shown)
    }

    private var stringBinding: Binding<String> {
        Binding(get: { value.stringValue ?? "" }, set: { value = $0.isEmpty ? .null : .string($0) })
    }

    private var numberBinding: Binding<String> {
        Binding(get: { value.numberValue.map { $0 == $0.rounded() ? String(Int64($0)) : String($0) } ?? (value.stringValue ?? "") },
                set: { text in value = text.isEmpty ? .null : Double(text).map(FormValue.number) ?? .string(text) })
    }

    private func multiBinding(_ option: String) -> Binding<Bool> {
        Binding(get: { value.arrayValue?.contains(.string(option)) ?? false },
                set: { on in
                    var items = (value.arrayValue ?? []).filter { $0 != .string(option) }
                    if on { items.append(.string(option)) }
                    value = .array(items)
                })
    }

    private var dateBinding: Binding<Date> {
        let formatter = ISO8601DateFormatter()
        return Binding(get: { value.stringValue.flatMap(formatter.date(from:)) ?? Date() },
                       set: { value = .string(formatter.string(from: $0)) })
    }
}

extension FieldErrorCode {
    var labelKey: LocalizedStringKey {
        switch self {
        case .required: return "form.error.required"
        case .type: return "form.error.type"
        case .minLength: return "form.error.min_length"
        case .maxLength: return "form.error.max_length"
        case .pattern: return "form.error.pattern"
        case .min: return "form.error.min"
        case .max: return "form.error.max"
        case .option: return "form.error.option"
        case .minItems: return "form.error.min_items"
        case .maxItems: return "form.error.max_items"
        case .notBefore: return "form.error.not_before"
        case .notAfter: return "form.error.not_after"
        case .accept: return "form.error.accept"
        case .maxSizeBytes: return "form.error.max_size_bytes"
        }
    }
}
