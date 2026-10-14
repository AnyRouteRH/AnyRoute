// H167
export default function YourImagesDocs() {
  return <section id="your-images"><h2>Your images</h2>
    <p>Open Your images beside Search history in Chat to browse every generated image saved in this browser’s unlocked history, including other message versions. Search the prompt text or filter by model, download the full image, use it as input in your draft or open its saved chat version.</p>
    <p>Enable Private mode, then create or unlock history with your passphrase. The gallery reads the existing encrypted browser history and creates no separate store. Locking history removes the gallery’s images from view. Browsing and downloading do not upload anything; Use as input prepares the image through Chat’s existing attachment tools and sends it only when you send the draft. The router still reads ordinary Chat requests in memory.</p>
    <p>Images are ordered by the chat’s last saved date, then by later replies within that chat. History does not record a separate creation date for each image. Only saved inline images appear; external image links and unsaved replies are excluded. Full-size downloads use the saved image bytes without the input size limit. Use as input keeps the existing 8 MB input limit and requires models that read images. The existing browser history size limit still applies.</p>
    <p>There is no new HTTP endpoint, authentication scope, server configuration flag or migration.</p>
  </section>;
}
