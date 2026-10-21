import AppKit
let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let bg = NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 215, yRadius: 215)
let colors = [NSColor(calibratedRed: 0.13, green: 0.19, blue: 0.34, alpha: 1), NSColor(calibratedRed: 0.24, green: 0.38, blue: 0.63, alpha: 1)]
NSGradient(colors: colors)?.draw(in: bg, angle: -50)
NSColor(calibratedWhite: 1, alpha: 0.16).setStroke()
bg.lineWidth = 7
bg.stroke()
let circle = NSBezierPath(ovalIn: NSRect(x: 164, y: 164, width: 696, height: 696))
NSColor(calibratedWhite: 1, alpha: 0.075).setFill()
circle.fill()
let cfg = NSImage.SymbolConfiguration(pointSize: 520, weight: .ultraLight)
    .applying(NSImage.SymbolConfiguration(paletteColors: [NSColor(calibratedRed: 0.8, green: 0.9, blue: 1, alpha: 1)]))
if let symbol = NSImage(systemSymbolName: "camera.aperture", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
    symbol.draw(in: NSRect(x: 230, y: 218, width: 564, height: 564), from: .zero, operation: .sourceOver, fraction: 1)
}
img.unlockFocus()
let tiff = img.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
let png = rep.representation(using: .png, properties: [:])!
try png.write(to: URL(fileURLWithPath: "/tmp/tonepilot-icon-1024.png"))
print("ICON_OK")
