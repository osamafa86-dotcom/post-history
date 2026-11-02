import AVFoundation
import CoreTransferable
import ImageIO
import MaterialsCore
import PostHistoryAPI
import SwiftUI
import UniformTypeIdentifiers

/// استيراد ملف مختار إلى مجلد الرفع كما هو (لا إعادة ترميز ولا تجريد؛ «الأصل لا يُمس»)، وقراءة حقائقه للعرض والطلب:
/// النوع والحجم والمدة ووقت التصوير. لا يُقرأ من الملف موقع ولا معرّف جهاز.
enum FileImport {
    static func importFile(_ url: URL) async throws -> MaterialDraft.PickedFile {
        let name = PickedTempFiles.originalName(url.lastPathComponent)
        let (path, size) = try UploadServices.shared.importFile(from: url, preferredName: name)
        let type = UTType(filenameExtension: url.pathExtension)
        let isVideo = type?.conforms(to: .movie) ?? false
        let copy = UploadServices.shared.documentsDirectory.appendingPathComponent(path)
        var duration: Double?
        if isVideo {
            duration = (try? await AVURLAsset(url: copy).load(.duration)).map(CMTimeGetSeconds)
        }
        let capturedAt = await captureDate(url: copy, isVideo: isVideo)
        return MaterialDraft.PickedFile(relativePath: path, filename: name, sizeBytes: size, mimeType: type?.preferredMIMEType,
                                        isVideo: isVideo, durationSeconds: duration, capturedAt: capturedAt)
    }

    /// وقت التصوير (`shot_at`): `creationDate` للفيديو، وEXIF `DateTimeOriginal` بإزاحته للصورة. بلا قيمة يبقى فارغًا.
    static func captureDate(url: URL, isVideo: Bool) async -> Date? {
        if isVideo {
            guard let item = try? await AVURLAsset(url: url).load(.creationDate) else { return nil }
            return try? await item.load(.dateValue)
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any],
              let original = exif[kCGImagePropertyExifDateTimeOriginal] as? String else { return nil }
        return CaptureDate.exif(original, offset: exif[kCGImagePropertyExifOffsetTimeOriginal] as? String)
    }
}

/// نقل الملف الأصلي من PhotosPicker كملف على القرص (لا بيانات في الذاكرة ولا تحويل).
struct PickedFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(PickedTempFiles.newName(for: received.file.lastPathComponent))
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedFile(url: copy)
        }
    }
}

/// نماذج المكتب المحفوظة مؤقتًا (لا بيانات مراسل فيها)؛ في مجلد Caches الذي يمحوه المسح الطارئ.
enum FormCache {
    private static func url(_ type: MaterialType) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("FormCache-\(type.rawValue).json")
    }

    static func save(_ form: UploadForm, type: MaterialType) {
        guard let data = try? CodableHelper().jsonEncoder.encode(form) else { return }
        try? data.write(to: url(type), options: .atomic)
    }

    static func load(type: MaterialType) -> UploadForm? {
        guard let data = try? Data(contentsOf: url(type)) else { return nil }
        return try? CodableHelper().jsonDecoder.decode(UploadForm.self, from: data)
    }
}
