// Approximate "after" render for the automated judge: applies an exposure change and a
// white-balance change to a Lightroom-rendered preview with Core Image. It approximates
// Lightroom; it is not Lightroom. Benchmark-only, never part of the app.
//
//   render <in.jpg> <out.jpg> <exposureEV> <fromKelvin> <toKelvin> <tintSteps>
//   render --probe <fromKelvin> <toKelvin> <tintSteps>   (prints the mean a*, b* shift of a grey)
import Foundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Lightroom: raising Temperature renders warmer, raising Tint renders more magenta. Core
// Image's neutral is the scene's white point, so the shift is applied in the opposite sense.
// TINT_SCALE maps Lightroom tint steps to Core Image tint units (fitted by --probe against
// colour.mjs's ~0.30 a* per Lightroom tint step).
let TINT_SCALE = 1.3

func adjusted(_ image: CIImage, ev: Double, fromK: Double, toK: Double, tint: Double) -> CIImage {
    var out = image
    if ev != 0 { out = out.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: ev]) }
    if fromK != toK || tint != 0 {
        out = out.applyingFilter("CITemperatureAndTint", parameters: [
            "inputNeutral": CIVector(x: CGFloat(toK), y: 0),
            "inputTargetNeutral": CIVector(x: CGFloat(fromK), y: CGFloat(-tint * TINT_SCALE))])
    }
    return out
}

func lab(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
    func lin(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    let (R, G, B) = (lin(r), lin(g), lin(b))
    let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047, y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B
    let z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883
    func f(_ t: Double) -> Double { t > 216.0 / 24389.0 ? cbrt(t) : (24389.0 / 27.0 * t + 16) / 116 }
    return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))
}

let context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!])
let args = CommandLine.arguments
if args.count == 5 && args[1] == "--probe" {
    let grey = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5)).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
    let out = adjusted(grey, ev: 0, fromK: Double(args[2])!, toK: Double(args[3])!, tint: Double(args[4])!)
    var px = [UInt8](repeating: 0, count: 4)
    context.render(out, toBitmap: &px, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8,
                   colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    let (_, a0, b0) = lab(0.5, 0.5, 0.5), (_, a1, b1) = lab(Double(px[0]) / 255, Double(px[1]) / 255, Double(px[2]) / 255)
    print(String(format: "{\"da\": %.2f, \"db\": %.2f}", a1 - a0, b1 - b0)); exit(0)
}
guard args.count == 7, let ev = Double(args[3]), let fromK = Double(args[4]), let toK = Double(args[5]), let tint = Double(args[6]),
      let input = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    fputs("usage: render <in.jpg> <out.jpg> <exposureEV> <fromKelvin> <toKelvin> <tintSteps>\n", stderr); exit(64)
}
do {
    try context.writeJPEGRepresentation(of: adjusted(input, ev: ev, fromK: fromK, toK: toK, tint: tint), to: URL(fileURLWithPath: args[2]),
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9])
} catch { fputs("render failed: \(error)\n", stderr); exit(1) }
