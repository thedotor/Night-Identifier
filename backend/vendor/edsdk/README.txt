Canon EDSDK support (optional, for Canon EOS cameras over USB)

The SDK is a free download for approved developers from Canon and cannot be redistributed, so it is NOT part of
this repository or of the installer. Get it from Canon, then put its 64-bit DLLs (EDSDK.dll, EdsImage.dll and the
rest of the SDK's dll folder) in ONE of these places:

  1. Documents\Night Identifier\edsdk        (installed app; survives updates)
  2. backend\vendor\edsdk                    (running from source; git-ignored)
  3. any folder, with the CANON_EDSDK_DIR environment variable pointing at it

Files here are ignored by git, and a normal build refuses to package them (see scripts\build-installer.ps1,
option -IncludeCanonSdk for private builds you will not share).
