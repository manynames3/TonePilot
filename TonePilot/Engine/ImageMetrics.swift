import AppKit
import Foundation

// Lightweight preview QA—not a professional colorimetric measurement.
guard CommandLine.arguments.count == 2,
      let image = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) else {
    fputs("JPEG read failed\n", stderr); exit(1)
}
let w=image.pixelsWide,h=image.pixelsHigh
guard w>0 && h>0 else { exit(2) }
let strideValue=max(1,Int(sqrt(Double(w*h)/24000.0)))
var lights=[Double]()
var blown=0, channelBlown=0, shadow=0
for y in Swift.stride(from:0,to:h,by:strideValue){
    for x in Swift.stride(from:0,to:w,by:strideValue){
        guard let c=image.colorAt(x:x,y:y)?.usingColorSpace(.deviceRGB) else {continue}
        let r=Double(c.redComponent),g=Double(c.greenComponent),b=Double(c.blueComponent)
        let lum=0.2126*r+0.7152*g+0.0722*b
        lights.append(lum)
        if r>0.985 && g>0.985 && b>0.985 {blown+=1}
        if max(r,g,b)>0.995{channelBlown+=1}
        if lum<0.025{shadow+=1}
    }
}
guard !lights.isEmpty else {exit(3)}
lights.sort()
func quantile(_ p:Double)->Double {lights[min(lights.count-1,Int(Double(lights.count-1)*p))]}
let total=Double(lights.count)
let output:[String:Any]=[
    "pixelsSampled":lights.count,"width":w,"height":h,
    "medianLuma":quantile(0.5),"p05Luma":quantile(0.05),"p95Luma":quantile(0.95),
    "whiteClippedFraction":Double(blown)/total,
    "channelClippedFraction":Double(channelBlown)/total,
    "deepShadowFraction":Double(shadow)/total
]
let data=try JSONSerialization.data(withJSONObject:output,options:[.sortedKeys])
print(String(decoding:data,as:UTF8.self))
