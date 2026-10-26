#if canImport(AVFoundation)
import AVFoundation
import CoreMedia
import Foundation

/// النسخة الخفيفة بـ AVFoundation وترميز العتاد (ADR 0075): H.264 وAAC أحادي في حاوية QuickTime.
/// - التدوير يُطبَّق، والتصغير بلا تكبير، وHDR وDolby Vision يُحوَّلان إلى SDR بـ Rec.709 في تركيب الفيديو.
/// - توقيت الإطارات يتبع المصدر (`sourceTrackIDForFrameTiming`) فلا يُعاد أخذ العينات لمعدل ثابت، والجلسة تبدأ من الصفر
///   فتبقى الإطارات على خط زمن الأصل نفسه.
/// - `start_pts` الأصل يُكتب في بيانات الحاوية بالمفتاح `proxyStartPtsMetadataKey`، لأن المرمّز قد يصفّر البداية.
public struct AVFoundationProxyTranscoder: ProxyTranscoder {
    public init() {}

    public func makeProxy(source: URL, preset: ProxyPreset, output: URL) async throws -> ProxyResult {
        let asset = AVURLAsset(url: source)
        guard let video = try await asset.loadTracks(withMediaType: .video).first else { throw ProxyError.noVideoTrack }
        let audio = try await asset.loadTracks(withMediaType: .audio).first
        let (naturalSize, transform, timeRange, nominalFPS, segments) = try await video.load(.naturalSize, .preferredTransform, .timeRange, .nominalFrameRate, .segments)
        let duration = try await asset.load(.duration)

        let shown = CGRect(origin: .zero, size: naturalSize).applying(transform)
        let size = preset.renderSize(displayWidth: Int(shown.width.rounded()), displayHeight: Int(shown.height.rounded()))
        let renderSize = CGSize(width: size.width, height: size.height)

        let composition = AVMutableVideoComposition()
        composition.renderSize = renderSize
        composition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(nominalFPS.rounded(), 1)))
        composition.sourceTrackIDForFrameTiming = video.trackID
        composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
        let scale = renderSize.width / max(shown.width, 1)
        let placed = transform
            .concatenating(CGAffineTransform(translationX: -shown.minX, y: -shown.minY))
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
        layer.setTransform(placed, at: .zero)
        instruction.layerInstructions = [layer]
        composition.instructions = [instruction]

        let reader = try AVAssetReader(asset: asset)
        let videoOut = AVAssetReaderVideoCompositionOutput(videoTracks: [video], videoSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        videoOut.videoComposition = composition
        videoOut.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOut) else { throw ProxyError.unsupported }
        reader.add(videoOut)
        try? FileManager.default.removeItem(at: output)
        let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
        writer.shouldOptimizeForNetworkUse = true
        let sourceStart = segments.first?.timeMapping.source.start ?? timeRange.start
        let startUs = sourceStart.isNumeric ? Int64((CMTimeGetSeconds(sourceStart) * 1_000_000).rounded()) : 0
        let item = AVMutableMetadataItem()
        item.keySpace = .quickTimeMetadata
        item.key = proxyStartPtsMetadataKey as NSString
        item.value = String(startUs) as NSString
        writer.metadata = [item]

        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width,
            AVVideoHeightKey: size.height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: preset.videoBitsPerSecond,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
            ],
        ])
        videoIn.expectsMediaDataInRealTime = false
        guard writer.canAdd(videoIn) else { throw ProxyError.unsupported }
        writer.add(videoIn)
        // الصوت يُقرأ فقط إن قبله الكاتب: مخرج قارئ لا يُستهلك يوقف القراءة كلها.
        var audioOut: AVAssetReaderTrackOutput?
        var audioIn: AVAssetWriterInput?
        if let audio {
            let out = AVAssetReaderTrackOutput(track: audio, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            out.alwaysCopiesSampleData = false
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: preset.audioBitsPerSecond,
            ])
            input.expectsMediaDataInRealTime = false
            if reader.canAdd(out), writer.canAdd(input) {
                reader.add(out); writer.add(input)
                audioOut = out; audioIn = input
            }
        }

        guard reader.startReading() else { throw ProxyError.failed(Self.code(reader.error)) }
        guard writer.startWriting() else { reader.cancelReading(); throw ProxyError.failed(Self.code(writer.error)) }
        writer.startSession(atSourceTime: .zero)

        await withTaskCancellationHandler {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await Self.pump(videoOut, into: videoIn, label: "proxy.video") }
                if let audioOut, let audioIn {
                    group.addTask { await Self.pump(audioOut, into: audioIn, label: "proxy.audio") }
                }
                await group.waitForAll()
            }
        } onCancel: {
            reader.cancelReading()
        }

        if Task.isCancelled {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: output)
            throw ProxyError.cancelled
        }
        if reader.status == .failed {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: output)
            throw ProxyError.failed(Self.code(reader.error))
        }
        await writer.finishWriting()
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: output)
            throw ProxyError.failed(Self.code(writer.error))
        }
        return ProxyResult(url: output, sourceStartPtsUs: startUs, durationSeconds: CMTimeGetSeconds(duration), width: size.width, height: size.height)
    }

    /// ينقل العينات من القارئ إلى الكاتب حتى ينتهي المصدر أو يرفض الكاتب عينة.
    private static func pump(_ out: AVAssetReaderOutput, into input: AVAssetWriterInput, label: String) async {
        let queue = DispatchQueue(label: label)
        let state = PumpState()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            input.requestMediaDataWhenReady(on: queue) {
                while !state.finished && input.isReadyForMoreMediaData {
                    if let buffer = out.copyNextSampleBuffer(), input.append(buffer) { continue }
                    state.finished = true
                    input.markAsFinished()
                    done.resume()
                }
            }
        }
    }

    /// رمز الخطأ فقط؛ لا مسارات ولا أسماء ملفات في الرسالة.
    private static func code(_ error: Error?) -> String {
        guard let error = error as NSError? else { return "unknown" }
        return "\(error.domain)#\(error.code)"
    }
}
/// حالة النقل؛ تُقرأ وتُكتب على طابور الإدخال وحده.
private final class PumpState: @unchecked Sendable {
    var finished = false
}
#endif
