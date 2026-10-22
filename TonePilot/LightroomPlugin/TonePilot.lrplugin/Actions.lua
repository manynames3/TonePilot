-- The only things a connected engine can ask Lightroom to do. One Develop write
-- action with a fixed key allowlist; everything else reads, selects or snapshots.
local LrApplication = import 'LrApplication'
local LrDate = import 'LrDate'
local LrStringUtils = import 'LrStringUtils'
local LrTasks = import 'LrTasks'

local JSON = require 'JSON'

local Actions = { version = "0.1.0", handlers = {} }
local handlers = Actions.handlers

-- Develop keys TonePilot may write, with coarse slider ranges. The engine enforces the
-- real (much smaller) limits; this is the last line if anything else ever connects.
local WRITABLE = { "WhiteBalance", "Temperature", "Tint", "IncrementalTemperature", "IncrementalTint",
    "Exposure2012", "Highlights2012", "Shadows2012", "Whites2012", "Blacks2012" }
local RANGE = {
    Temperature = { 2000, 50000 }, Tint = { -150, 150 },
    IncrementalTemperature = { -100, 100 }, IncrementalTint = { -100, 100 }, Exposure2012 = { -5, 5 },
    Highlights2012 = { -100, 100 }, Shadows2012 = { -100, 100 }, Whites2012 = { -100, 100 }, Blacks2012 = { -100, 100 },
}
local WB_MODES = { ["As Shot"] = true, Auto = true, Daylight = true, Cloudy = true, Shade = true,
    Tungsten = true, Fluorescent = true, Flash = true, Custom = true }
-- The Develop History step names a write may carry (the History panel takes its name from
-- applyDevelopSettings; withWriteAccessDo's name is only the Undo label).
local HISTORY_STEPS = { ["TonePilot first pass"] = true, ["TonePilot restore"] = true }

-- The field names the Lightroom MCP bridge reports, so the engine reads both bridges alike.
local FIELDS = {
    whiteBalance = "WhiteBalance", temperature = "Temperature", tint = "Tint",
    incrementalTemperature = "IncrementalTemperature", incrementalTint = "IncrementalTint",
    exposure = "Exposure2012", contrast = "Contrast2012", highlights = "Highlights2012",
    shadows = "Shadows2012", whites = "Whites2012", blacks = "Blacks2012",
    texture = "Texture", clarity = "Clarity2012", dehaze = "Dehaze", vibrance = "Vibrance",
    saturation = "Saturation", convertToGrayscale = "ConvertToGrayscale", toneCurveName = "ToneCurveName2012",
    toneCurve = "ToneCurvePV2012", toneCurveRed = "ToneCurvePV2012Red",
    toneCurveGreen = "ToneCurvePV2012Green", toneCurveBlue = "ToneCurvePV2012Blue",
    parametricShadows = "ParametricShadows", parametricDarks = "ParametricDarks",
    parametricLights = "ParametricLights", parametricHighlights = "ParametricHighlights",
}
local EXIF = { "cameraModel", "cameraSerialNumber", "lens", "isoSpeedRating", "aperture", "shutterSpeed",
    "flash", "focalLength", "exposureBias", "dateTimeOriginal" }

local function count(value, default, max)
    local n = math.floor(tonumber(value) or default)
    if n < 0 then return 0 end
    if n > max then return max end
    return n
end

-- getPhotoByLocalId can return an object for an ID that no longer exists, so the
-- photo is confirmed by its uuid. Catalog queries stay outside read/write gates.
local function photoById(catalog, id)
    local n = tonumber(id)
    if not n or n < 1 or n ~= math.floor(n) then error("Invalid photo_id: " .. tostring(id), 0) end
    local photo = catalog:getPhotoByLocalId(n)
    local raw = photo and catalog:batchGetRawMetadata({ photo }, { "uuid" }) or {}
    if not photo or not (raw[photo] or {}).uuid then error("Photo not found: " .. tostring(id), 0) end
    return photo
end

function handlers.hello()
    local catalog = LrApplication.activeCatalog()
    return { pluginVersion = Actions.version, lightroomVersion = LrApplication.versionString(),
        catalogPath = catalog:getPath() }
end

function handlers.writable_keys()
    local keys = JSON.array({})
    for i, key in ipairs(WRITABLE) do keys[i] = key end
    return { keys = keys }
end

-- Lightroom reports the whole filmstrip when nothing is selected; the engine shows
-- the filenames it will work on.
function handlers.get_selected_photos(params)
    local catalog = LrApplication.activeCatalog()
    local limit, offset = count(params.limit, 100, 1000), count(params.offset, 0, 1000000)
    -- Outside withReadAccessDo: reading the live selection inside the gate can deadlock.
    local targets = catalog:getTargetPhotos() or {}
    local page = {}
    for i = offset + 1, math.min(offset + limit, #targets) do page[#page + 1] = targets[i] end
    local photos = JSON.array({})
    if #page > 0 then
        local raw = catalog:batchGetRawMetadata(page, { "path" }) or {}
        local formatted = catalog:batchGetFormattedMetadata(page, { "fileName", "dateTimeOriginal" }) or {}
        for i, photo in ipairs(page) do
            local r, f = raw[photo] or {}, formatted[photo] or {}
            photos[i] = { id = photo.localIdentifier, path = r.path, filename = f.fileName, dateTimeOriginal = f.dateTimeOriginal }
        end
    end
    return { count = #targets, photos = photos }
end

function handlers.get_photo_metadata(params)
    local catalog = LrApplication.activeCatalog()
    local photo = photoById(catalog, params.photo_id)
    local result
    catalog:withReadAccessDo(function()
        local settings = photo:getDevelopSettings() or {}
        local develop = {}
        for name, key in pairs(FIELDS) do develop[name] = settings[key] end
        -- Every scalar Develop value, so a change anywhere (crop, profile, masks' amounts…)
        -- is seen by the engine's staleness and read-back checks.
        local full = {}
        for key, value in pairs(settings) do
            local t = type(value)
            if type(key) == "string" and (t == "number" or t == "string" or t == "boolean") then full[key] = value end
        end
        develop.full = full
        result = { id = photo.localIdentifier, path = photo:getRawMetadata("path"),
            filename = photo:getFormattedMetadata("fileName"), fileFormat = photo:getRawMetadata("fileFormat"),
            developSettings = develop }
        for _, key in ipairs(EXIF) do result[key] = photo:getFormattedMetadata(key) end
    end)
    return result
end

local function jpegSize(data)
    if data:byte(1) ~= 0xFF or data:byte(2) ~= 0xD8 then return nil end
    local pos = 3
    while pos + 8 <= #data do
        if data:byte(pos) ~= 0xFF then return nil end
        local marker = data:byte(pos + 1)
        if marker >= 0xC0 and marker <= 0xCF and marker ~= 0xC4 and marker ~= 0xC8 and marker ~= 0xCC then
            return data:byte(pos + 7) * 256 + data:byte(pos + 8), data:byte(pos + 5) * 256 + data:byte(pos + 6)
        end
        pos = pos + 2 + data:byte(pos + 2) * 256 + data:byte(pos + 3)
    end
    return nil
end

function handlers.get_photo_preview(params)
    local size = count(params.size, 640, 2048)
    if size < 64 then size = 64 end
    local catalog = LrApplication.activeCatalog()
    local photo = photoById(catalog, params.photo_id)
    local done, data, failure = false, nil, nil
    -- The request must stay referenced until the callback fires or Lightroom may cancel it.
    local request = photo:requestJpegThumbnail(size, size, function(jpeg, message)
        if not done then done, data, failure = true, jpeg, message end
    end)
    local deadline = LrDate.currentTime() + 20
    while request and not done and LrDate.currentTime() < deadline do LrTasks.sleep(0.05) end
    if not done then error("Preview failed: not ready after 20 s", 0) end
    if not data then error("Preview failed: " .. tostring(failure or "no image data"), 0) end
    local width, height = jpegSize(data)
    return { photo_id = photo.localIdentifier, width = width, height = height,
        image = { mime_type = "image/jpeg", data = LrStringUtils.encodeBase64(data) } }
end

function handlers.set_develop_settings(params)
    local settings = params.settings
    if type(settings) ~= "table" then error("settings is required", 0) end
    local n = 0
    for key, value in pairs(settings) do
        if key == "WhiteBalance" then
            if not WB_MODES[value] then error("Unknown white balance mode: " .. tostring(value), 0) end
        elseif not RANGE[key] then
            error("Develop setting not allowed: " .. tostring(key), 0)
        elseif type(value) ~= "number" or value ~= value or value < RANGE[key][1] or value > RANGE[key][2] then
            error("Out-of-range value for " .. key, 0)
        end
        n = n + 1
    end
    if n == 0 then error("settings is required", 0) end
    local history = params.history or "TonePilot first pass"
    if not HISTORY_STEPS[history] then error("Unknown history step: " .. tostring(history), 0) end
    local catalog = LrApplication.activeCatalog()
    local photo = photoById(catalog, params.photo_id)
    local written = false
    catalog:withWriteAccessDo(history, function()
        photo:applyDevelopSettings(settings, history)
        written = true
    end, { timeout = 10 })
    if not written then error("Lightroom's catalog was busy; nothing was written", 0) end
    return { success = true, photo_id = photo.localIdentifier }
end

-- Best effort: a named Develop snapshot of the photo before TonePilot first changes it.
function handlers.create_snapshot(params)
    local name = params.name
    if type(name) ~= "string" or name == "" or #name > 100 then error("name is required", 0) end
    local catalog = LrApplication.activeCatalog()
    local photo = photoById(catalog, params.photo_id)
    local available, method = pcall(function() return photo.createDevelopSnapshot end)
    if not available or type(method) ~= "function" then return { supported = false } end
    local created = false
    catalog:withWriteAccessDo("TonePilot snapshot", function()
        photo:createDevelopSnapshot(name, true)
        created = true
    end, { timeout = 10 })
    return { supported = true, created = created, name = name }
end

-- "Show in Lightroom". Lightroom ignores photos outside the current source, so the
-- selection is read back rather than assumed.
function handlers.select_photos(params)
    local ids = params.photo_ids
    if type(ids) ~= "table" or #ids == 0 or #ids > 500 then error("photo_ids is required", 0) end
    local catalog = LrApplication.activeCatalog()
    local photos, wanted, missing = {}, {}, JSON.array({})
    for _, id in ipairs(ids) do
        local ok, photo = pcall(photoById, catalog, id)
        if ok and not wanted[photo] then
            photos[#photos + 1] = photo
            wanted[photo] = true
        elseif not ok then
            missing[#missing + 1] = tostring(id)
        end
    end
    if #photos == 0 then error("None of the photos were found in this catalog", 0) end
    catalog:setSelectedPhotos(photos[1], photos)
    local selected = 0
    for _, photo in ipairs(catalog:getTargetPhotos() or {}) do
        if wanted[photo] then selected = selected + 1 end
    end
    return { requested = #photos, selected = selected, missing = missing }
end

return Actions
