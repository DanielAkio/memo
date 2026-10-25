# Code signing

Unsigned installers make browsers and Windows SmartScreen warn that the file "may be dangerous". Memo applies to
[SignPath Foundation](https://signpath.org), which signs open source projects for free, for the Windows installer.
macOS notarization needs the paid Apple Developer Program and is not set up; Linux packages need no signature.

Even signed, SmartScreen can still warn on the first downloads of a new certificate until it builds reputation.

## What the workflow does

`.github/workflows/build.yml` signs only when the repository has the `SIGNPATH_API_TOKEN` secret. Then the Windows
job builds as usual, uploads the `*-setup.exe` as the `memo-windows-unsigned` artifact, submits it to
SignPath and waits (up to an hour) for the request to be approved and signed. The signed file becomes the
`memo-windows-latest` artifact and, on a `v*` tag, is added to the draft release. Without the secret nothing changes:
the installer stays unsigned.

## Setting it up

1. Apply at <https://signpath.org/apply> with the repository URL. The code signing policy page
   (`site/code-signing.html`, linked from the README) is the policy SignPath asks for.
2. Once accepted, in SignPath:
   - link the GitHub trusted build system to the project;
   - name the project `memo`, the signing policy `release-signing` and the artifact configuration `installers`
     (the workflow uses these slugs), with this configuration:

     ```xml
     <?xml version="1.0" encoding="utf-8"?>
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file path="*-setup.exe">
           <authenticode-sign/>
         </pe-file>
       </zip-file>
     </artifact-configuration>
     ```

   - create an API token for a CI user that may submit to `release-signing`.
3. In GitHub → Settings → Secrets and variables → Actions, add the secret `SIGNPATH_API_TOKEN` (the token) and the
   variable `SIGNPATH_ORGANIZATION_ID` (the SignPath organization id).
4. Run the workflow and approve the signing request in SignPath while the Windows job waits.

Only the installer itself is signed; `Memo.exe` inside it is not. That is enough for the download warning,
which checks the file that was downloaded.
