-- Localhost socket server. LrSocket sockets carry data one way only, so the engine
-- sends newline-delimited JSON requests to REQUEST_PORT and reads the responses from
-- RESPONSE_PORT. Every request must carry the token written to bridge.json.
--
--   request:  {"id": 1, "token": "…", "action": "hello", "params": {}}
--   response: {"id": 1, "result": {…}}   or   {"id": 1, "error": "…"}
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrSocket = import 'LrSocket'
local LrTasks = import 'LrTasks'
local LrUUID = import 'LrUUID'

local JSON = require 'JSON'
local Actions = require 'Actions'

local Server = {}

local REQUEST_PORT = 58781    -- engine -> Lightroom (LrSocket "receive")
local RESPONSE_PORT = 58782   -- Lightroom -> engine (LrSocket "send")
local SEND_WAIT_SECONDS = 10

local state = { log = {} }    -- the running instance; also on _G for MenuStatus.lua

function Server.log(message)
    local log = state.log
    log[#log + 1] = os.date("%H:%M:%S") .. " " .. message
    if #log > 20 then table.remove(log, 1) end
end

local function bridgeFile()
    local home = LrPathUtils.getStandardFilePath("home")
    local folder = LrPathUtils.child(LrPathUtils.child(LrPathUtils.child(home, "Library"), "Application Support"), "TonePilot")
    return folder, LrPathUtils.child(folder, "bridge.json")
end

local function quote(path)
    return "'" .. path:gsub("'", "'\\''") .. "'"
end

local function readToken()
    local _, path = bridgeFile()
    local fh = io.open(path, "r")
    if not fh then return nil end
    local text = fh:read("*a")
    fh:close()
    local ok, data = pcall(JSON.decode, text)
    if ok and type(data) == "table" then return data.token end
    return nil
end

-- The token lets a local process drive Lightroom: folder 0700, file 0600.
local function writeBridgeFile(token)
    local folder, path = bridgeFile()
    LrFileUtils.createAllDirectories(folder)
    LrTasks.execute("/bin/chmod 700 " .. quote(folder))
    local fh = assert(io.open(path, "w"))
    fh:write(JSON.encode({ version = 1, plugin = Actions.version, requestPort = REQUEST_PORT,
        responsePort = RESPONSE_PORT, token = token }))
    fh:close()
    if LrTasks.execute("/bin/chmod 600 " .. quote(path)) ~= 0 then error("Could not restrict " .. path, 0) end
end

local function newToken()
    return (LrUUID.generateUUID() .. LrUUID.generateUUID()):gsub("-", ""):lower()
end

-- Listen-side states while no engine is attached; not failures.
local function isIdle(err)
    err = tostring(err)
    return err == "timeout" or err:find("failed to open", 1, true) ~= nil
end

function Server.run(context)
    local me = { log = state.log, running = true, requests = 0, responseGen = 1 }
    state = me
    _G.TonePilotBridgeState = me
    me.token = newToken()
    writeBridgeFile(me.token)

    context:addCleanupHandler(function()
        me.running = false
        if me.requestSocket then pcall(function() me.requestSocket:close() end) end
        if me.responseSocket then pcall(function() me.responseSocket:close() end) end
    end)

    local function send(response)
        local waited = 0
        while not me.sendConnected and waited < SEND_WAIT_SECONDS do
            LrTasks.sleep(0.1)
            waited = waited + 0.1
        end
        if not me.sendConnected or not me.responseSocket then
            Server.log("Response " .. tostring(response.id) .. " dropped: engine not connected")
            return
        end
        local ok, payload = pcall(JSON.encode, response)
        if not ok then payload = JSON.encode({ id = response.id, error = "Response could not be encoded: " .. tostring(payload) }) end
        me.responseSocket:send(payload .. "\n")
    end

    local function handle(request)
        local handler = type(request.action) == "string" and Actions.handlers[request.action]
        if not handler then
            send({ id = request.id, error = "Unknown action: " .. tostring(request.action) })
            return
        end
        local params = type(request.params) == "table" and request.params or {}
        local ok, result = LrTasks.pcall(handler, params)
        me.requests = me.requests + 1
        if ok then send({ id = request.id, result = result })
        else send({ id = request.id, error = tostring(result) }) end
    end

    -- Runs in a callback that must not yield: decode and check here, act in a task.
    local function onMessage(message)
        local ok, request = pcall(JSON.decode, message)
        if not ok or type(request) ~= "table" then
            Server.log("Malformed request ignored")
            return
        end
        if type(request.token) ~= "string" or request.token ~= me.token then
            Server.log("Request without a valid token refused")
            LrTasks.startAsyncTask(function() send({ id = request.id, error = "Unauthorized" }) end)
            return
        end
        LrTasks.startAsyncTask(function() handle(request) end)
    end

    local function bindRequest()
        return LrSocket.bind {
            functionContext = context, plugin = _PLUGIN, port = REQUEST_PORT, mode = "receive",
            onConnected = function()
                me.receiveConnected = true
                -- A new engine: give it a fresh response listener, because a send-mode
                -- socket does not always notice that the previous engine went away.
                me.responseNeedsRebind = true
                Server.log("Engine connected")
            end,
            onMessage = function(_, message) onMessage(message) end,
            onClosed = function()
                me.receiveConnected = false
                me.requestNeedsReconnect = true
            end,
            onError = function(_, err)
                if isIdle(err) and me.receiveConnected then return end
                if not isIdle(err) then
                    me.receiveConnected = false
                    Server.log("Request socket: " .. tostring(err))
                end
                me.requestNeedsReconnect = true
            end,
        }
    end

    -- Each rebind bumps a generation so callbacks from a closed listener are ignored.
    local function bindResponse(gen)
        local function live() return me.responseGen == gen end
        return LrSocket.bind {
            functionContext = context, plugin = _PLUGIN, port = RESPONSE_PORT, mode = "send",
            onConnected = function() if live() then me.sendConnected = true end end,
            onClosed = function()
                if not live() then return end
                me.sendConnected = false
                me.responseNeedsRebind = true
            end,
            onError = function(_, err)
                if not live() then return end
                if isIdle(err) then
                    if not me.sendConnected then me.responseNeedsReconnect = true end
                else
                    me.sendConnected = false
                    me.responseNeedsRebind = true
                    Server.log("Response socket: " .. tostring(err))
                end
            end,
        }
    end

    me.requestSocket = bindRequest()
    me.responseSocket = bindResponse(me.responseGen)
    Server.log("Listening on localhost ports " .. REQUEST_PORT .. " and " .. RESPONSE_PORT)

    local ticks = 0
    while me.running do
        ticks = ticks + 1
        if ticks % 5 == 0 then
            -- Reload Plug-in can leave an older instance running; the newest owns bridge.json.
            local token = readToken()
            if token == nil then pcall(writeBridgeFile, me.token)
            elseif token ~= me.token then
                Server.log("Superseded by a newer instance")
                break
            end
        end
        if me.requestNeedsReconnect then
            me.requestNeedsReconnect = false
            me.requestSocket:reconnect()
        end
        if me.responseNeedsRebind then
            me.responseNeedsRebind = false
            me.responseNeedsReconnect = false
            me.responseGen = me.responseGen + 1
            me.sendConnected = false
            pcall(function() me.responseSocket:close() end)
            LrTasks.sleep(0.1)
            me.responseSocket = bindResponse(me.responseGen)
        elseif me.responseNeedsReconnect then
            me.responseNeedsReconnect = false
            me.responseSocket:reconnect()
        end
        LrTasks.sleep(0.2)
    end
    me.running = false
end

return Server
