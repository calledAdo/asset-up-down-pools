//! The product wordmark: the tug-of-war mark (the parimutuel signature shrunk to
//! a logo) beside "Tilt". The mark derives from the theme tokens (--up/--down/…)
//! so it reads correctly in every theme.

export function Brand() {
  return (
    <>
      <span className="logo-mark" />
      <span className="wm">Tilt</span>
    </>
  );
}
