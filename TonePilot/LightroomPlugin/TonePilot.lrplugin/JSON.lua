-- Minimal JSON for the bridge protocol (Lua 5.1). Numbers are formatted and parsed
-- without the C locale, which may use a decimal comma.
local JSON = {}

local ARRAY = {}
-- Marks a table as a JSON array, so an empty list encodes as [] rather than {}.
function JSON.array(t) return setmetatable(t or {}, ARRAY) end

local ESCAPES = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

local function encodeString(s)
    return '"' .. s:gsub('[%c"\\]', function(c) return ESCAPES[c] or string.format("\\u%04x", c:byte()) end) .. '"'
end

local function isArray(t)
    if getmetatable(t) == ARRAY then return true end
    local n = 0
    for k in pairs(t) do
        if type(k) ~= "number" or k < 1 or k ~= math.floor(k) then return false end
        n = n + 1
    end
    return n > 0 and n == #t
end

local function encode(value, depth)
    if depth > 32 then error("JSON nesting too deep", 0) end
    local t = type(value)
    if value == nil then return "null" end
    if t == "boolean" then return tostring(value) end
    if t == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return "null" end
        if value == math.floor(value) and math.abs(value) < 1e15 then return string.format("%d", value) end
        return (string.format("%.14g", value):gsub(",", "."))
    end
    if t == "string" then return encodeString(value) end
    if t ~= "table" then error("Cannot encode a " .. t, 0) end
    local parts = {}
    if isArray(value) then
        for i = 1, #value do parts[i] = encode(value[i], depth + 1) end
        return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, v in pairs(value) do
        parts[#parts + 1] = encodeString(tostring(k)) .. ":" .. encode(v, depth + 1)
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

function JSON.encode(value) return encode(value, 0) end

local function skip(s, pos)
    return s:find("[^ \t\r\n]", pos) or #s + 1
end

local function utf8(c)
    if c < 0x80 then return string.char(c) end
    if c < 0x800 then return string.char(0xC0 + math.floor(c / 0x40), 0x80 + c % 0x40) end
    if c < 0x10000 then
        return string.char(0xE0 + math.floor(c / 0x1000), 0x80 + math.floor(c / 0x40) % 0x40, 0x80 + c % 0x40)
    end
    return string.char(0xF0 + math.floor(c / 0x40000), 0x80 + math.floor(c / 0x1000) % 0x40,
        0x80 + math.floor(c / 0x40) % 0x40, 0x80 + c % 0x40)
end

local UNESCAPE = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }

local function decodeString(s, pos)
    local out, i = {}, pos + 1
    while true do
        local c = s:sub(i, i)
        if c == "" then error("Unterminated string", 0) end
        if c == '"' then return table.concat(out), i + 1 end
        if c == "\\" then
            local e = s:sub(i + 1, i + 1)
            if UNESCAPE[e] then
                out[#out + 1] = UNESCAPE[e]
                i = i + 2
            elseif e == "u" then
                local code = tonumber(s:sub(i + 2, i + 5), 16)
                if not code then error("Bad \\u escape", 0) end
                i = i + 6
                if code >= 0xD800 and code <= 0xDBFF and s:sub(i, i + 1) == "\\u" then
                    local low = tonumber(s:sub(i + 2, i + 5), 16)
                    if low and low >= 0xDC00 and low <= 0xDFFF then
                        code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
                        i = i + 6
                    end
                end
                out[#out + 1] = utf8(code)
            else
                error("Bad escape", 0)
            end
        else
            local j = s:find('["\\]', i) or #s + 1
            out[#out + 1] = s:sub(i, j - 1)
            i = j
        end
    end
end

local function decodeNumber(s, pos)
    local text = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
    local sign, int, frac, exp = (text or ""):match("^(-?)(%d+)%.?(%d*)[eE]?([-+]?%d*)$")
    if not int then error("Bad number at " .. pos, 0) end
    local n = tonumber(int)
    if frac ~= "" then n = n + tonumber(frac) / 10 ^ #frac end
    local e = tonumber((exp:gsub("^%+", "")))
    if e then n = n * 10 ^ e end
    if sign == "-" then n = -n end
    return n, pos + #text
end

local decodeValue

local function decodeList(s, pos, depth, close, item)
    pos = skip(s, pos + 1)
    if s:sub(pos, pos) == close then return pos + 1 end
    while true do
        pos = skip(s, item(pos, depth + 1))
        local c = s:sub(pos, pos)
        if c == close then return pos + 1 end
        if c ~= "," then error("Expected ',' or '" .. close .. "' at " .. pos, 0) end
        pos = skip(s, pos + 1)
    end
end

decodeValue = function(s, pos, depth)
    if depth > 32 then error("JSON nesting too deep", 0) end
    pos = skip(s, pos)
    local c = s:sub(pos, pos)
    if c == "{" then
        local object = {}
        pos = decodeList(s, pos, depth, "}", function(p, d)
            if s:sub(p, p) ~= '"' then error("Expected a key at " .. p, 0) end
            local key, after = decodeString(s, p)
            after = skip(s, after)
            if s:sub(after, after) ~= ":" then error("Expected ':' at " .. after, 0) end
            local value
            value, after = decodeValue(s, after + 1, d)
            object[key] = value
            return after
        end)
        return object, pos
    end
    if c == "[" then
        local array, n = JSON.array({}), 0
        pos = decodeList(s, pos, depth, "]", function(p, d)
            local value, after = decodeValue(s, p, d)
            n = n + 1
            array[n] = value
            return after
        end)
        return array, pos
    end
    if c == '"' then return decodeString(s, pos) end
    if c == "-" or c:match("%d") then return decodeNumber(s, pos) end
    if s:sub(pos, pos + 3) == "true" then return true, pos + 4 end
    if s:sub(pos, pos + 4) == "false" then return false, pos + 5 end
    if s:sub(pos, pos + 3) == "null" then return nil, pos + 4 end
    error("Unexpected input at " .. pos, 0)
end

function JSON.decode(s)
    local value, pos = decodeValue(s, 1, 0)
    if skip(s, pos) <= #s then error("Trailing data at " .. pos, 0) end
    return value
end

return JSON
