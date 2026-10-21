import AppKit
import Foundation

let artboard = NSSize(width: 1024, height: 1024)
let art = NSImage(size: artboard)
func col(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: r/255, green:g/255, blue:b/255, alpha:a)
}

art.lockFocus()
let plate=NSBezierPath(roundedRect:NSRect(x:36,y:36,width:952,height:952),xRadius:228,yRadius:228)
col(244,239,230).setFill()
plate.fill()
plate.lineWidth=5
col(223,209,196).setStroke()
plate.stroke()

let center=NSPoint(x:512,y:522)
let radius:CGFloat=305
let circle=NSBezierPath(ovalIn:NSRect(x:center.x-radius,y:center.y-radius,width:radius*2,height:radius*2))
col(247,243,234).setFill()
circle.fill()

NSGraphicsContext.current?.saveGraphicsState()
circle.addClip()
let terracotta=NSBezierPath(rect:NSRect(x:center.x+4,y:center.y-radius,width:radius,height:radius*2))
col(174,88,66).setFill()
terracotta.fill()
let stripe=NSBezierPath(rect:NSRect(x:center.x+55,y:center.y-radius,width:48,height:radius*2))
col(202,134,103,0.92).setFill()
stripe.fill()
let farStripe=NSBezierPath(rect:NSRect(x:center.x+190,y:center.y-radius,width:22,height:radius*2))
col(90,55,48,0.20).setFill()
farStripe.fill()
NSGraphicsContext.current?.restoreGraphicsState()

circle.lineWidth=12
col(150,72,52).setStroke()
circle.stroke()

// Subtle photographic geometric mark, unlike an aperture/radiation symbol.
let mainLine=NSBezierPath()
mainLine.move(to:NSPoint(x:512,y:217))
mainLine.line(to:NSPoint(x:512,y:827))
mainLine.lineWidth=9
col(98,56,48,0.80).setStroke()
mainLine.stroke()

let shortLine=NSBezierPath()
shortLine.move(to:NSPoint(x:279,y:526))
shortLine.line(to:NSPoint(x:508,y:526))
shortLine.lineWidth=7
col(98,56,48,0.76).setStroke()
shortLine.stroke()

let diagonal=NSBezierPath()
diagonal.move(to:NSPoint(x:355,y:526))
diagonal.line(to:NSPoint(x:470,y:652))
diagonal.line(to:NSPoint(x:509,y:670))
diagonal.lineWidth=7
col(98,56,48,0.74).setStroke()
diagonal.stroke()

art.unlockFocus()
guard let tiff=art.tiffRepresentation,
      let bitmap=NSBitmapImageRep(data:tiff),
      let png=bitmap.representation(using:.png,properties:[:]) else { fatalError("Icon rendering failed") }
try png.write(to:URL(fileURLWithPath:"/tmp/tonepilot-icon-1024.png"))
print("TonePilot editorial icon generated")
