-- Runs TonePilot.lrplugin's Lua outside Lightroom against stub SDK objects. It checks
-- the plug-in's own logic (allowlist, JSON, auth, bridge.json); it says nothing about
-- how the real Lightroom SDK behaves.   lua plugin-harness.lua <plugin dir> <temp home>
local pluginDir, home = arg[1], arg[2]
package.path = pluginDir .. "/?.lua;" .. package.path

local settings = { WhiteBalance = "As Shot", Temperature = 5200, Tint = 4, Exposure2012 = 0, Contrast2012 = 0,
    CropTop = 0, ToneCurvePV2012 = { 0, 0, 255, 255 } }
local history, snapshots, selected, executed, inWrite = {}, {}, {}, {}, false

local photo = { localIdentifier = 101 }
function photo:getDevelopSettings() local c = {} for k, v in pairs(settings) do c[k] = v end return c end
local steps = {}
function photo:applyDevelopSettings(s, step) assert(inWrite, "write outside withWriteAccessDo") steps[#steps + 1] = step for k, v in pairs(s) do settings[k] = v end end
function photo:getRawMetadata(k) return ({ path = "/Photos/A.CR3", fileFormat = "RAW" })[k] end
function photo:getFormattedMetadata(k) return ({ fileName = "A.CR3", cameraModel = "Mock" })[k] end
function photo:createDevelopSnapshot(name, update) assert(inWrite and update) snapshots[#snapshots + 1] = name end
function photo:requestJpegThumbnail(w, h, done) done("\255\216\255\192\0\17\8\1\44\1\144", nil) return {} end

local catalog = {}
-- Like Lightroom, an unknown local ID can still yield an object; only its uuid is missing.
function catalog:getPhotoByLocalId(n) return n == 101 and photo or { localIdentifier = n } end
function catalog:batchGetRawMetadata(list) local r = {} for _, p in ipairs(list) do r[p] = p == photo and { uuid = "u", path = "/Photos/A.CR3" } or {} end return r end
function catalog:batchGetFormattedMetadata(list) local r = {} for _, p in ipairs(list) do r[p] = { fileName = "A.CR3" } end return r end
function catalog:getTargetPhotos() return selected end
function catalog:setSelectedPhotos(_, list) selected = list end
function catalog:withReadAccessDo(f) f() end
function catalog:withWriteAccessDo(name, f) history[#history + 1] = name inWrite = true f() inWrite = false end
function catalog:getPath() return "/Catalogs/Test.lrcat" end

local sockets, uuid = {}, 0
local SDK = {
    LrApplication = { activeCatalog = function() return catalog end, versionString = function() return "14.5.1" end },
    LrDate = { currentTime = os.time },
    LrStringUtils = { encodeBase64 = function(s) return "b64:" .. #s end },
    LrTasks = { pcall = pcall, startAsyncTask = function(f) f() end,
        execute = function(cmd) executed[#executed + 1] = cmd return os.execute(cmd) and 0 or 1 end },
    LrPathUtils = { getStandardFilePath = function() return home end, child = function(a, b) return a .. "/" .. b end },
    LrFileUtils = { createAllDirectories = function(p) os.execute("mkdir -p '" .. p .. "'") end },
    LrUUID = { generateUUID = function() uuid = uuid + 1 return "ABCD-" .. uuid end },
    LrSocket = { bind = function(opts)
        local s = { opts = opts, sent = {} }
        function s:send(x) self.sent[#self.sent + 1] = x end
        function s:close() self.closed = true end
        function s:reconnect() end
        sockets[opts.mode] = s
        return s
    end },
}
function import(name) return assert(SDK[name], name) end
_PLUGIN = {}

local JSON = require "JSON"
local Actions = require "Actions"
local Server = require "Server"
local h = Actions.handlers

local function fails(pattern, f, ...)
    local ok, err = pcall(f, ...)
    assert(not ok, "expected an error matching " .. pattern)
    assert(tostring(err):find(pattern), tostring(err))
end

-- JSON
local back = JSON.decode(JSON.encode({ a = 0.35, b = { 1, 2 }, c = JSON.array({}), d = 'q"\n\1', e = true }))
assert(back.a == 0.35 and back.b[2] == 2 and #back.c == 0 and back.d == 'q"\n\1' and back.e == true)
assert(JSON.encode(JSON.array({})) == "[]" and JSON.encode({ x = 0.5 }) == '{"x":0.5}')
assert(JSON.decode('"\\u00e9\\ud83d\\ude00"') == "\195\169\240\159\152\128")
assert(JSON.decode(" [-1.5e2, 12] ")[1] == -150)
fails("Trailing", JSON.decode, '{"a":1} x')

-- The write allowlist: nothing outside it reaches Lightroom.
fails("not allowed", h.set_develop_settings, { photo_id = 101, settings = { Contrast2012 = 10 } })
fails("not allowed", h.set_develop_settings, { photo_id = 101, settings = { Exposure2012 = 0.3, CropTop = 0.1 } })
fails("Out%-of%-range", h.set_develop_settings, { photo_id = 101, settings = { Exposure2012 = 9 } })
fails("Out%-of%-range", h.set_develop_settings, { photo_id = 101, settings = { Temperature = "5000" } })
fails("white balance mode", h.set_develop_settings, { photo_id = 101, settings = { WhiteBalance = "Neon" } })
fails("settings is required", h.set_develop_settings, { photo_id = 101, settings = {} })
fails("not found", h.set_develop_settings, { photo_id = 999, settings = { Exposure2012 = 0.3 } })
assert(#history == 0 and settings.Exposure2012 == 0, "rejected writes never reach Lightroom")
local w = h.set_develop_settings({ photo_id = "101", settings = { Exposure2012 = 0.3, WhiteBalance = "Custom" } })
assert(w.success and settings.Exposure2012 == 0.3 and history[1] == "TonePilot first pass" and steps[1] == "TonePilot first pass")
h.set_develop_settings({ photo_id = 101, settings = { Exposure2012 = 0.3 }, history = "TonePilot restore" })
assert(steps[2] == "TonePilot restore", "restores are named in History")
fails("history step", h.set_develop_settings, { photo_id = 101, settings = { Exposure2012 = 0.1 }, history = "Anything" })
assert(#h.writable_keys().keys == 10)

-- Reads
local m = h.get_photo_metadata({ photo_id = 101 })
assert(m.id == 101 and m.filename == "A.CR3" and m.fileFormat == "RAW" and m.cameraModel == "Mock")
assert(m.developSettings.exposure == 0.3 and m.developSettings.whiteBalance == "Custom")
assert(m.developSettings.full.CropTop == 0 and m.developSettings.full.ToneCurvePV2012 == nil, "full holds scalars only")
assert(JSON.decode(JSON.encode(m)).developSettings.toneCurve[3] == 255)
local p = h.get_photo_preview({ photo_id = 101, size = 640 })
assert(p.width == 400 and p.height == 300 and p.image.mime_type == "image/jpeg")

-- Selection
local sel = h.get_selected_photos({ limit = 5 })
assert(sel.count == 0 and JSON.encode(sel.photos) == "[]")
local r = h.select_photos({ photo_ids = { 101, 999 } })
assert(r.selected == 1 and r.requested == 1 and r.missing[1] == "999")
sel = h.get_selected_photos({ limit = 5, offset = 0 })
assert(sel.count == 1 and sel.photos[1].id == 101 and sel.photos[1].path == "/Photos/A.CR3")
fails("None of the photos", h.select_photos, { photo_ids = { 999 } })

-- Snapshots
local snap = h.create_snapshot({ photo_id = 101, name = "TonePilot before abc123" })
assert(snap.supported and snap.created and snapshots[1] == "TonePilot before abc123")
photo.createDevelopSnapshot = nil
assert(h.create_snapshot({ photo_id = 101, name = "x" }).supported == false)

-- Server: bridge.json, token check, dispatch, response framing, superseding.
local cleanup, phase, firstSend
local file = home .. "/Library/Application Support/TonePilot/bridge.json"
SDK.LrTasks.sleep = function()
    if not phase then
        phase = 1
        firstSend = sockets.send
        sockets.receive.opts.onConnected()
    elseif phase == 1 and sockets.send ~= firstSend then
        phase = 2
        sockets.send.opts.onConnected()
        local token = JSON.decode(io.open(file):read("*a")).token
        local message = sockets.receive.opts.onMessage
        message(nil, JSON.encode({ id = 1, token = "wrong", action = "hello" }))
        message(nil, JSON.encode({ id = 2, token = token, action = "hello" }))
        message(nil, JSON.encode({ id = 3, token = token, action = "set_gps", params = {} }))
        message(nil, "not json")
        message(nil, JSON.encode({ id = 4, action = "writable_keys" }))
        local fh = io.open(file, "w")
        fh:write('{"token":"newer"}')
        fh:close()
    end
end
Server.run({ addCleanupHandler = function(_, f) cleanup = f end })
local info = JSON.decode(io.open(home .. "/Library/Application Support/TonePilot/bridge.json"):read("*a"))
assert(info.token == "newer", "superseded instance leaves the newer bridge.json alone")
local sent = sockets.send.sent
assert(#sent == 4 and firstSend.closed, "one response per request, on the rebound response socket")
for _, line in ipairs(sent) do assert(line:sub(-1) == "\n") end
local replies = {}
for _, line in ipairs(sent) do local x = JSON.decode(line) replies[x.id] = x end
assert(replies[1].error == "Unauthorized" and replies[1].result == nil)
assert(replies[2].result.pluginVersion == Actions.version and replies[2].result.catalogPath == "/Catalogs/Test.lrcat")
assert(replies[3].error:find("Unknown action"))
assert(replies[4].error == "Unauthorized")
local chmods = table.concat(executed, "\n")
assert(chmods:find("chmod 700") and chmods:find("chmod 600 '.-bridge%.json%.tmp'"), "restricted before it is renamed into place")
assert(type(cleanup) == "function")
print("plugin harness: ok")
