# RFC 3161 fixtures (AECI-1680)

Used by `src/lib/rfc3161.spec.ts` and `src/lib/acceptance-chain-export.spec.ts`. No spec touches the network.

- `digicert-request.tsq`: the `TimeStampReq` that `buildTimeStampRequest` built for digest `f6abbf5e…4099` and nonce `137edbde3dcd3829`.
- `digicert-response.tsr`: DigiCert's real reply to that request from `http://timestamp.digicert.com` on 2026-11-17 (genTime 00:22:23Z). `openssl ts -verify -in digicert-response.tsr -queryfile digicert-request.tsq -CAfile ../../../../scripts/certs/digicert-tsa-chain.pem` prints `Verification: OK`.
- `throwaway-ca-response.tsr`: a correctly signed reply to the same request from a TSA outside the pinned chain. Made on 2026-11-17 with a throwaway self-signed RSA CA (`openssl req -x509`) and a TSA certificate it issued with `extendedKeyUsage=critical,timeStamping`, then `openssl ts -reply -queryfile digicert-request.tsq -signer tsa.pem -inkey tsa.key -chain ca.pem` (sha256 digests, `ess_cert_id_alg = sha256`). The keys were deleted. The verifier must reject it as `unpinned_issuer`.
- `throwaway-no-eku-response.tsr`: the TSTInfo from the throwaway reply, re-signed by a second throwaway certificate with no extended key usage. Made with `openssl cms -sign -binary -nodetach -keyid -econtent_type 1.2.840.113549.1.9.16.1.4 -md sha256 -nosmimecap` over the extracted TSTInfo, then wrapped in `TimeStampResp { status 0, token }`. `-keyid` makes the SignerInfo name its certificate by subject key identifier. The verifier must reject it as `signer_cert_eku`.
