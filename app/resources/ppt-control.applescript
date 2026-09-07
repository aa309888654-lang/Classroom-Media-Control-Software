-- 小天AIGC 课堂中控 · macOS 放映控制脚本
-- 用法: osascript ppt-control.applescript <action> [path] [close] [exportDir]
--   action: start | exit | status | next | prev | pageinfo | presenter
-- 约定与 Windows 版 ppt-control.ps1 相同：stdout 最后一行输出单行 JSON。
-- 注意：macOS 上只有 Microsoft PowerPoint 提供可用的 AppleScript 接口，WPS/Keynote 不支持自动化。

on jsonEscape(s)
	set s to s as text
	set out to ""
	repeat with c in characters of s
		if c is "\"" then
			set out to out & "\\\""
		else if c is "\\" then
			set out to out & "\\\\"
		else
			set out to out & c
		end if
	end repeat
	return "\"" & out & "\""
end jsonEscape

on pptInstalled()
	try
		-- 读取 bundle id 不会启动应用；未安装则抛错
		get id of application "Microsoft PowerPoint"
		return true
	on error
		return false
	end try
end pptInstalled

on pptRunning()
	return application "Microsoft PowerPoint" is running
end pptRunning

on presentingCount()
	if not pptRunning() then return 0
	tell application "Microsoft PowerPoint"
		try
			return count of slide show windows
		on error
			return 0
		end try
	end tell
end presentingCount

on currentFilePath()
	if not pptRunning() then return ""
	tell application "Microsoft PowerPoint"
		try
			return full name of active presentation as text
		on error
			return ""
		end try
	end tell
end currentFilePath

on jsonErr(code, msg)
	return "{\"ok\":false,\"error\":\"" & code & "\",\"detail\":" & my jsonEscape(msg) & "}"
end jsonErr

on run argv
	if (count of argv) < 1 then return jsonErr("bad-args", "missing action") of me
	set act to item 1 of argv
	set pptPath to ""
	if (count of argv) > 1 then set pptPath to item 2 of argv
	set closeApp to true
	if (count of argv) > 2 then set closeApp to (item 3 of argv is "true")

	if act is "start" then
		if not my pptInstalled() then return my jsonErr("no-office-com", "Microsoft PowerPoint 未安装")
		if pptPath is "" then return my jsonErr("file-not-found", "empty path")
		try
			set posixPath to pptPath
			tell application "Microsoft PowerPoint"
				launch
				open (POSIX file posixPath)
				delay 1
				set ss to slide show settings of active presentation
				run slide show ss
			end tell
			return "{\"ok\":true,\"progId\":\"PowerPoint.Mac\"}"
		on error errMsg
			return my jsonErr("com-error", errMsg)
		end try

	else if act is "exit" then
		set wasPresenting to (my presentingCount()) > 0
		if wasPresenting then
			tell application "Microsoft PowerPoint"
				try
					exit slide show (slide show view of slide show window 1)
				end try
			end tell
		end if
		if closeApp and my pptRunning() then
			tell application "Microsoft PowerPoint"
				try
					quit saving no
				end try
			end tell
		end if
		return "{\"ok\":true,\"wasPresenting\":" & (wasPresenting as text) & "}"

	else if act is "status" then
		set isPresenting to (my presentingCount()) > 0
		set f to my currentFilePath()
		return "{\"ok\":true,\"presenting\":" & (isPresenting as text) & ",\"file\":" & my jsonEscape(f) & "}"

	else if act is "next" or act is "prev" then
		if (my presentingCount()) is 0 then return my jsonErr("not-presenting", "no slide show window")
		tell application "Microsoft PowerPoint"
			try
				if act is "next" then
					go to next slide (slide show view of slide show window 1)
				else
					go to previous slide (slide show view of slide show window 1)
				end if
				delay 0.1
				set pos to slide index of slide show view of slide show window 1
				set tot to count of slides of active presentation
			on error errMsg
				return my jsonErr("com-error", errMsg)
			end try
		end tell
		return "{\"ok\":true,\"presenting\":true,\"position\":" & pos & ",\"total\":" & tot & "}"

	else if act is "pageinfo" then
		if (my presentingCount()) is 0 then return "{\"ok\":true,\"presenting\":false}"
		tell application "Microsoft PowerPoint"
			try
				set pos to slide index of slide show view of slide show window 1
				set tot to count of slides of active presentation
			on error errMsg
				return my jsonErr("com-error", errMsg)
			end try
		end tell
		return "{\"ok\":true,\"presenting\":true,\"position\":" & pos & ",\"total\":" & tot & "}"

	else if act is "presenter" then
		-- Mac 版 V1：提供页码与备注；当前/下一页缩略图暂不支持（PowerPoint for Mac 的 AppleScript 无稳定导出接口）
		if (my presentingCount()) is 0 then return "{\"ok\":true,\"presenting\":false}"
		tell application "Microsoft PowerPoint"
			try
				set pos to slide index of slide show view of slide show window 1
				set tot to count of slides of active presentation
				set curNotes to ""
				set nextNotes to ""
				try
					set curNotes to notes of slide pos of active presentation as text
				end try
				if pos < tot then
					try
						set nextNotes to notes of slide (pos + 1) of active presentation as text
					end try
				end if
			on error errMsg
				return my jsonErr("com-error", errMsg)
			end try
		end tell
		return "{\"ok\":true,\"presenting\":true,\"position\":" & pos & ",\"total\":" & tot & "," & ¬
			"\"notes\":" & my jsonEscape(curNotes) & ",\"nextNotes\":" & my jsonEscape(nextNotes) & "," & ¬
			"\"curImg\":\"\",\"nextImg\":\"\"}"
	end if

	return my jsonErr("bad-action", "unknown action: " & act)
end run
