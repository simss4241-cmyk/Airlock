Option Explicit
' Airlock launcher — the thing a taskbar icon should point at.
'
' Makes sure the server is up (starting it hidden if not), waits for it to answer, then
' opens Airlock in app mode: its own window, no tabs, no address bar. No console window at
' any point. Resolves its own folder, so the whole project can be moved.

Dim fso, sh, base, url, i, browser

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
url = "http://localhost:8100"

If Not ServerUp(url) Then
    sh.Run "node server.js", 0, False
    ' Cold node start is fast, but give it room rather than racing it.
    For i = 1 To 30
        WScript.Sleep 500
        If ServerUp(url) Then Exit For
    Next
End If

' Reuse the existing app window instead of opening another one on every shortcut click.
' The helper matches an exact "Airlock" title owned by Edge or Chrome, so a File Explorer
' window named "Airlock" is never mistaken for the app.
If FocusExistingWindow() Then WScript.Quit

browser = FindBrowser()

If browser = "" Then
    sh.Run url, 1, False                                  ' default browser, normal window
Else
    sh.Run """" & browser & """ --app=" & url, 1, False   ' app mode
End If

' True only if the server answers a real request — a listening socket isn't enough.
Function ServerUp(u)
    Dim http
    ServerUp = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", u & "/api/config", False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Then ServerUp = True
    End If
    Err.Clear
    On Error GoTo 0
End Function

' True when an existing Airlock window was found — whether or not Windows let us raise it.
' Exit 4 means found-but-not-raised, and that still has to stop us: opening a second app
' window would leave two Airlocks instead of one that merely didn't come forward.
Function FocusExistingWindow()
    Dim helper, command, exitCode
    helper = fso.BuildPath(base, "tools\focus_airlock.ps1")

    FocusExistingWindow = False
    If Not fso.FileExists(helper) Then Exit Function

    command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden " & _
              "-ExecutionPolicy Bypass -File """ & helper & """"
    exitCode = sh.Run(command, 0, True)
    FocusExistingWindow = (exitCode = 0) Or (exitCode = 4)
End Function

' Chromium is needed for --app mode. Edge first, then Chrome.
Function FindBrowser()
    Dim candidates, p
    candidates = Array( _
        sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
        sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
        sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
        sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
        sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe")

    FindBrowser = ""
    For Each p In candidates
        If fso.FileExists(p) Then
            FindBrowser = p
            Exit Function
        End If
    Next
End Function
