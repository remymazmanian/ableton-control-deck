-- Uninstall Ableton Control Deck: removes the services, the remote script, and this computer's data
-- (or keeps settings and snapshots), then the program files, which needs an administrator password.
set runtime to "/Library/Application Support/Ableton Control Deck"
set appFolder to "/Applications/Ableton Control Deck"
set choice to button returned of (display dialog "Uninstall Ableton Control Deck?" with title "Ableton Control Deck" buttons {"Cancel", "Remove Everything", "Keep Settings"} default button "Keep Settings" cancel button "Cancel" with icon caution)
if choice is "Keep Settings" then
	set dataFlag to "--keep-data"
else
	set dataFlag to "--remove-data"
end if
set problems to ""
try
	do shell script quoted form of (runtime & "/bin/node") & " " & quoted form of (runtime & "/scripts/uninstall.mjs") & " " & dataFlag
on error message
	set problems to message
end try
do shell script "/bin/rm -rf " & quoted form of runtime & " " & quoted form of appFolder & "; /usr/sbin/pkgutil --forget com.abletondeck.controldeck >/dev/null 2>&1; true" with administrator privileges
if problems is "" then
	display dialog "Ableton Control Deck was removed." with title "Ableton Control Deck" buttons {"OK"} default button "OK"
else
	display dialog "Ableton Control Deck was removed, with problems:" & return & return & problems with title "Ableton Control Deck" buttons {"OK"} default button "OK" with icon caution
end if
