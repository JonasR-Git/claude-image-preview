/** A file that is not the format it claims, is damaged, or uses a feature no decoder here reads. */
export class DecodeError extends Error {
  override name = 'DecodeError'
}

/** A format or variant that can be valid, but that the built-in decoders do not read. */
export class UnsupportedError extends DecodeError {
  override name = 'UnsupportedError'
}
