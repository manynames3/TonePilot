// TonePilotAnalyzer — local, read-only measurements of a Lightroom-rendered JPEG preview.
//
//   TonePilotAnalyzer <preview.jpg> [--original <source file>]
//   TonePilotAnalyzer --selftest
//
// Measures what a photographer looks at first: faces. Everything runs on-device
// (Vision + CoreGraphics); nothing leaves the Mac. These are approximations made on an
// 8-bit sRGB preview, NOT colorimetric measurements of the RAW file. The original is
// only opened for EXIF metadata; its pixels are never decoded.
import Foundation
import CoreGraphics
import ImageIO
import Vision

struct Lab { var L: Double; var a: Double; var b: Double }

@inline(__always) func toLinear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
@inline(__always) func toSRGB(_ c: Double) -> Double { c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055 }

func labFromLinear(_ r: Double, _ g: Double, _ b: Double) -> Lab {
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883
    func f(_ t: Double) -> Double { t > 216.0 / 24389.0 ? cbrt(t) : (24389.0 / 27.0 * t + 16) / 116 }
    return Lab(L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)))
}

func round4(_ x: Double) -> Double { (x * 10000).rounded() / 10000 }

struct Pixels {
    let width: Int, height: Int
    var data: [UInt8]
    init(_ image: CGImage, maxEdge: Int = 512) throws {
        let scale = min(1.0, Double(maxEdge) / Double(max(image.width, image.height)))
        width = max(1, Int(Double(image.width) * scale)); height = max(1, Int(Double(image.height) * scale))
        data = [UInt8](repeating: 0, count: width * height * 4)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw NSError(domain: "TonePilot", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot create bitmap"])
        }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    @inline(__always) func rgb(_ x: Int, _ y: Int) -> (Double, Double, Double) {
        let i = (y * width + x) * 4
        return (Double(data[i]) / 255, Double(data[i + 1]) / 255, Double(data[i + 2]) / 255)
    }
}

func quantile(_ sorted: [Double], _ p: Double) -> Double {
    sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * p))]
}
func median(_ v: [Double]) -> Double { quantile(v.sorted(), 0.5) }

let channelClip = 254.0 / 255.0
let clipLinear = toLinear(channelClip)

func globalStats(_ px: Pixels) -> [String: Any] {
    var lumas = [Double](); lumas.reserveCapacity(px.width * px.height)
    var white = 0, channel = 0, shadow = 0, neutralCount = 0
    var neutralA = 0.0, neutralB = 0.0, meanLinear = 0.0
    var headroom = [Int](repeating: 0, count: 20)   // pixels that clip within k*0.05 EV
    var grid = [Double](repeating: 0, count: 16 * 3), gridN = [Int](repeating: 0, count: 16)
    for y in 0..<px.height {
        for x in 0..<px.width {
            let (r, g, b) = px.rgb(x, y)
            let lr = toLinear(r), lg = toLinear(g), lb = toLinear(b)
            let Y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
            meanLinear += Y
            let ls = toSRGB(Y)
            lumas.append(ls)
            if r > 0.985 && g > 0.985 && b > 0.985 { white += 1 }
            let mx = max(lr, lg, lb)
            if max(r, g, b) >= channelClip { channel += 1 }
            else if mx > 0 {
                let room = log2(clipLinear / mx)
                if room <= 1.0 { let k = max(0, Int((room / 0.05).rounded(.up)) - 1); for j in k..<20 { headroom[j] += 1 } }
            }
            if ls < 0.025 { shadow += 1 }
            let c = (y * 4 / px.height) * 4 + (x * 4 / px.width)
            grid[c * 3] += lr; grid[c * 3 + 1] += lg; grid[c * 3 + 2] += lb; gridN[c] += 1
            if ls > 0.3 && ls < 0.95 {
                let lab = labFromLinear(lr, lg, lb)
                if hypot(lab.a, lab.b) < 8 { neutralA += lab.a; neutralB += lab.b; neutralCount += 1 }
            }
        }
    }
    let total = Double(lumas.count)
    lumas.sort()
    var gridLab = [Double]()
    for c in 0..<16 {
        let n = Double(max(1, gridN[c]))
        let lab = labFromLinear(grid[c * 3] / n, grid[c * 3 + 1] / n, grid[c * 3 + 2] / n)
        gridLab += [round4(lab.L), round4(lab.a), round4(lab.b)]
    }
    let channelFraction = Double(channel) / total
    return [
        "luma": ["median": round4(quantile(lumas, 0.5)), "p05": round4(quantile(lumas, 0.05)),
                 "p95": round4(quantile(lumas, 0.95)), "meanLinear": round4(meanLinear / total)],
        "clip": ["white": round4(Double(white) / total), "channel": round4(channelFraction),
                 "deepShadow": round4(Double(shadow) / total)],
        "clipAtEV": headroom.map { round4(channelFraction + Double($0) / total) },
        "neutral": ["a": round4(neutralCount > 0 ? neutralA / Double(neutralCount) : 0),
                    "b": round4(neutralCount > 0 ? neutralB / Double(neutralCount) : 0),
                    "fraction": round4(Double(neutralCount) / total)],
        "grid": gridLab
    ]
}

// Median colour of the central skin region of a face box (normalized, top-left origin).
func regionStats(_ px: Pixels, _ box: CGRect) -> [String: Any]? {
    let x0 = Int(Double(px.width) * (box.minX + box.width * 0.25)), x1 = Int(Double(px.width) * (box.minX + box.width * 0.75))
    let y0 = Int(Double(px.height) * (box.minY + box.height * 0.40)), y1 = Int(Double(px.height) * (box.minY + box.height * 0.85))
    var rs = [Double](), gs = [Double](), bs = [Double](), ys = [Double]()
    for y in max(0, y0)..<min(px.height, max(y0 + 1, y1)) {
        for x in max(0, x0)..<min(px.width, max(x0 + 1, x1)) {
            let (r, g, b) = px.rgb(x, y)
            let lr = toLinear(r), lg = toLinear(g), lb = toLinear(b)
            let Y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
            let ls = toSRGB(Y)
            if ls < 0.05 || ls > 0.97 { continue }
            rs.append(lr); gs.append(lg); bs.append(lb); ys.append(Y)
        }
    }
    guard ys.count >= 12 else { return nil }
    let lab = labFromLinear(median(rs), median(gs), median(bs))
    var hue = atan2(lab.b, lab.a) * 180 / .pi
    if hue < 0 { hue += 360 }
    let luma = median(ys)
    return ["luma": round4(luma), "lumaSRGB": round4(toSRGB(luma)), "lab": [round4(lab.L), round4(lab.a), round4(lab.b)],
            "hue": round4(hue), "chroma": round4(hypot(lab.a, lab.b)), "samples": ys.count]
}

func topLeft(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: 1 - r.maxY, width: r.width, height: r.height) }

func subjectStats(_ image: CGImage, _ px: Pixels) -> [String: Any] {
    let faceRequest = VNDetectFaceRectanglesRequest()
    let humanRequest = VNDetectHumanRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([faceRequest, humanRequest])
    var faces = [[String: Any]]()
    for f in (faceRequest.results ?? []) where f.boundingBox.width * f.boundingBox.height >= 0.0015 {
        let box = topLeft(f.boundingBox)
        guard var stats = regionStats(px, box) else { continue }
        stats["box"] = [round4(box.minX), round4(box.minY), round4(box.width), round4(box.height)]
        stats["area"] = round4(box.width * box.height)
        stats["confidence"] = round4(Double(f.confidence))
        faces.append(stats)
    }
    faces.sort { ($0["area"] as! Double) > ($1["area"] as! Double) }
    let persons = humanRequest.results ?? []
    var subject: [String: Any] = ["method": "none"]
    if let largest = faces.first?["area"] as? Double {
        let dominant = faces.filter { ($0["area"] as! Double) >= largest * 0.25 }
        let luma = median(dominant.map { $0["luma"] as! Double })
        subject = ["method": "face", "luma": round4(luma), "lumaSRGB": round4(toSRGB(luma)), "count": dominant.count,
                   "area": round4(dominant.reduce(0) { $0 + ($1["area"] as! Double) })]
    } else if let body = persons.max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) {
        let box = topLeft(body.boundingBox)
        if let stats = regionStats(px, CGRect(x: box.minX, y: box.minY, width: box.width, height: box.height * 0.5)) {
            subject = ["method": "person", "luma": stats["luma"]!, "lumaSRGB": stats["lumaSRGB"]!,
                       "area": round4(box.width * box.height)]
        }
    }
    return ["faces": faces, "persons": persons.count, "subject": subject]
}

func exifFromOriginal(_ path: String) -> [String: Any]? {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let src = CGImageSourceCreateWithURL(url, [kCGImageSourceShouldCache: false] as CFDictionary),
          let props = CGImageSourceCopyPropertiesAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary) as? [CFString: Any]
    else { return nil }
    let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
    let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
    var out = [String: Any]()
    if let t = exif[kCGImagePropertyExifDateTimeOriginal] as? String { out["captureTime"] = t }
    if let s = exif[kCGImagePropertyExifSubsecTimeOriginal] as? String { out["subsec"] = s }
    if let o = exif[kCGImagePropertyExifOffsetTimeOriginal] as? String { out["offset"] = o }
    if let f = exif[kCGImagePropertyExifFlash] as? Int { out["flashFired"] = (f & 1) == 1 }
    if let iso = (exif[kCGImagePropertyExifISOSpeedRatings] as? [Int])?.first { out["iso"] = iso }
    if let t = exif[kCGImagePropertyExifExposureTime] as? Double { out["exposureTime"] = t }
    if let n = exif[kCGImagePropertyExifFNumber] as? Double { out["fNumber"] = n }
    if let fl = exif[kCGImagePropertyExifFocalLength] as? Double { out["focalLength"] = fl }
    if let lens = exif[kCGImagePropertyExifLensModel] as? String { out["lens"] = lens }
    if let model = tiff[kCGImagePropertyTIFFModel] as? String { out["model"] = model }
    return out
}

func analyze(_ image: CGImage, original: String?) throws -> [String: Any] {
    let started = Date()
    let px = try Pixels(image)
    var out = globalStats(px)
    for (k, v) in subjectStats(image, px) { out[k] = v }
    out["version"] = 1
    out["width"] = image.width; out["height"] = image.height
    if let original, let exif = exifFromOriginal(original) { out["exif"] = exif }
    out["ms"] = Int(Date().timeIntervalSince(started) * 1000)
    return out
}

// ---- Self-test on synthetic images (no photographs needed) ----

func solidImage(_ w: Int, _ h: Int, _ fill: (Int, Int) -> (UInt8, UInt8, UInt8)) -> CGImage {
    var data = [UInt8](repeating: 255, count: w * h * 4)
    for y in 0..<h { for x in 0..<w { let (r, g, b) = fill(x, y); let i = (y * w + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b } }
    let provider = CGDataProvider(data: Data(data) as CFData)!
    return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
}

func selftest() -> Bool {
    var checks = [[String: Any]]()
    func check(_ name: String, _ ok: Bool, _ detail: String) { checks.append(["name": name, "ok": ok, "detail": detail]) }
    do {
        let gray = try analyze(solidImage(200, 150) { _, _ in (118, 118, 118) }, original: nil)
        let luma = gray["luma"] as! [String: Double], clip = gray["clip"] as! [String: Double]
        check("mid-grey brightness", abs(luma["median"]! - 118.0 / 255) < 0.01 && abs(luma["meanLinear"]! - 0.181) < 0.01,
              "median \(luma["median"]!) linear \(luma["meanLinear"]!)")
        check("no clipping on grey", clip["channel"]! == 0, "channel \(clip["channel"]!)")
        check("no face on grey", (gray["subject"] as! [String: Any])["method"] as! String == "none", "")
        let half = try analyze(solidImage(200, 150) { x, _ in x < 100 ? (255, 255, 255) : (0, 0, 0) }, original: nil)
        let hc = half["clip"] as! [String: Double]
        check("half clipped", abs(hc["channel"]! - 0.5) < 0.02 && abs(hc["deepShadow"]! - 0.5) < 0.02, "\(hc)")
        let ramp = try analyze(solidImage(256, 20) { x, _ in (UInt8(x), UInt8(x), UInt8(x)) }, original: nil)
        let curve = ramp["clipAtEV"] as! [Double]
        check("headroom curve is monotonic", zip(curve, curve.dropFirst()).allSatisfy { $0 <= $1 } && curve.last! > curve.first!,
              "\(curve.first!)…\(curve.last!)")
        let red = labFromLinear(1, 0, 0)
        check("sRGB red in CIELAB", abs(red.L - 53.24) < 0.2 && abs(red.a - 80.09) < 0.3 && abs(red.b - 67.20) < 0.3,
              "\(red.L) \(red.a) \(red.b)")
        let grid = ramp["grid"] as! [Double]
        check("grid descriptor", grid.count == 48 && grid[0] < grid[9], "cells \(grid.count / 3)")
    } catch {
        check("analysis ran", false, error.localizedDescription)
    }
    let ok = checks.allSatisfy { $0["ok"] as! Bool }
    let data = try! JSONSerialization.data(withJSONObject: ["passed": ok, "checks": checks], options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    return ok
}

// ---- Entry point ----

let args = CommandLine.arguments
if args.count == 2 && args[1] == "--selftest" { exit(selftest() ? 0 : 1) }
guard args.count == 2 || (args.count == 4 && args[2] == "--original") else {
    fputs("usage: TonePilotAnalyzer <preview.jpg> [--original <file>] | --selftest\n", stderr); exit(64)
}
guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fputs("preview unreadable\n", stderr); exit(1) }
do {
    let result = try analyze(image, original: args.count == 4 ? args[3] : nil)
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} catch {
    fputs("analysis failed: \(error.localizedDescription)\n", stderr); exit(2)
}
