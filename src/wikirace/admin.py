"""The admin API, and the two public endpoints that feed it (docs/traffic.md).

Open to anyone:

  POST   /api/contact                       a copy of a Contact page message (enquiries.py)
  POST   /api/beacon                        what only the browser knows about a page view (traffic.py)
  POST   /api/admin/login                   sign in: {email, password}; sets the session cookie
  POST   /api/admin/logout                  sign out

The admin's only, checked on every request (`require_admin`):

  GET    /api/admin/me                      who is signed in, until when
  GET    /api/admin/traffic                 the report: totals, series, top lists
  GET    /api/admin/traffic/requests        the request log, a page at a time
  GET    /api/admin/traffic/requests.csv    the same rows, every one, as CSV
  GET    /api/admin/signins                 the sign-in log
  GET    /api/admin/audit                   what the admin did
  GET    /api/admin/enquiries               enquiries, newest first
  POST   /api/admin/enquiries/{id}/handled  {handled: true|false}
  DELETE /api/admin/enquiries/{id}

Nothing on the public site links to /admin; that is presentation only. Every
admin endpoint asks for the session itself. Everything these endpoints return
was written by strangers (paths, user agents, emails, messages), and the admin
page shows all of it as text.
"""
from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterator
from typing import Annotated, Any, TypeVar
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from . import enquiries, logins, traffic
from .config import Settings

public = APIRouter(prefix="/api")
auth = APIRouter(prefix="/api/admin")

M = TypeVar("M", bound=BaseModel)
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_TZ = re.compile(r"[A-Za-z0-9_+\-/]{1,64}")


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _who(request: Request) -> dict[str, Any]:
    return traffic.visitor(request.headers, request.client.host if request.client else "")


async def _body(request: Request, limit: int) -> bytes:
    """The request body, refused past *limit* bytes before it is all read: a
    public endpoint must not buffer whatever it is sent."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="too large")
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > limit:
            raise HTTPException(status_code=413, detail="too large")
    return bytes(buf)


def _parse(model: type[M], raw: bytes) -> M:
    try:
        return model.model_validate_json(raw or b"{}")
    except ValidationError as exc:
        fields = ", ".join(sorted({str(e["loc"][0]) for e in exc.errors() if e.get("loc")})) or "the body"
        raise HTTPException(status_code=422, detail=f"not accepted: {fields}") from exc


def _same_origin(request: Request) -> bool:
    """A state-changing request must come from this site's own page. The
    cookie is SameSite=Strict already; this is the second lock."""
    origin = request.headers.get("origin")
    if not origin:
        return True
    try:
        return urlsplit(origin).netloc.lower() == request.headers.get("host", "").lower()
    except ValueError:
        return False


# ── The Contact page and the beacon ──────────────────────────────────────────


class ContactIn(BaseModel):
    name: str = Field("", max_length=200)
    email: str = Field(max_length=254)
    message: str = Field(min_length=1, max_length=5000)
    #: The trap: hidden from people, filled in by scripts.
    cabinet_code: str = Field("", max_length=200)


@public.post("/contact", status_code=202)
async def contact(request: Request) -> dict[str, Any]:
    """Keep a copy of a Contact page message. A trap, a repeat and a success
    all look alike from outside."""
    who = _who(request)
    limit = request.app.state.contact_limit
    if limit.blocked(who["ip"]):
        raise HTTPException(status_code=429, detail="too many messages; try again later")
    body = _parse(ContactIn, await _body(request, 16_000))
    if not _EMAIL.fullmatch(body.email.strip()) or not body.message.strip():
        raise HTTPException(status_code=422, detail="not accepted: email, message")
    limit.hit(who["ip"])
    if body.cabinet_code:
        return {"ok": True}
    await run_in_threadpool(
        enquiries.add, _settings(request).db_path, name=body.name, email=body.email, message=body.message, who=who,
    )
    return {"ok": True}


class BeaconIn(BaseModel):
    sw: int = Field(0, ge=0, le=20_000)
    sh: int = Field(0, ge=0, le=20_000)
    vw: int = Field(0, ge=0, le=20_000)
    vh: int = Field(0, ge=0, le=20_000)
    dpr: float = Field(0, ge=0, le=10)
    tz: str = Field("", max_length=64)
    load_ms: int | None = Field(None, ge=0, le=600_000)
    view: str = Field("", max_length=300)


@public.post("/beacon", status_code=204)
async def beacon(request: Request) -> Response:
    """A page view's browser-side facts, added to this request's own row in
    the traffic log. No cookie, no identifier: nothing ties one beacon to the
    next but the address the log already has."""
    b = _parse(BeaconIn, await _body(request, 2_000))
    extra = request.scope.get(traffic.EXTRA)
    if extra is not None:
        extra.update({
            "screen": f"{b.sw}x{b.sh}" if b.sw and b.sh else "",
            "viewport": f"{b.vw}x{b.vh}" if b.vw and b.vh else "",
            "pixel_ratio": round(b.dpr, 2) or None,
            "timezone": b.tz if _TZ.fullmatch(b.tz) else "",
            "load_ms": b.load_ms,
            "view": traffic.redact_query(b.view.removeprefix("?"))[:300],
        })
    return Response(status_code=204)


# ── Signing in ───────────────────────────────────────────────────────────────


class LoginIn(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=1024)


def _cookie(request: Request, response: Response, token: str, max_age: int) -> None:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    response.set_cookie(
        logins.COOKIE, token, max_age=max_age, path=logins.COOKIE_PATH,
        httponly=True, samesite="strict", secure=proto == "https",
    )


@auth.post("/login")
async def login(request: Request, response: Response) -> dict[str, Any]:
    s = _settings(request)
    if not s.admin_email or not s.admin_password_hash:
        raise HTTPException(status_code=503, detail=(
            "Admin sign-in is off: set WIKIRACE_ADMIN_EMAIL and WIKIRACE_ADMIN_PASSWORD_HASH "
            "(wikirace --hash-password writes the hash)"))
    if not _same_origin(request):
        raise HTTPException(status_code=403, detail="not from this site")
    who = _who(request)
    limit = request.app.state.login_limit
    wait = limit.blocked(who["ip"])
    if wait:
        minutes = max(1, round(wait / 60))
        raise HTTPException(status_code=429, detail=f"Too many attempts. Try again in {minutes} min.",
                            headers={"Retry-After": str(int(wait) + 1)})
    body = _parse(LoginIn, await _body(request, 4_000))
    ok = await run_in_threadpool(logins.check, body.email, body.password, s.admin_email, s.admin_password_hash)
    if not ok:
        limit.hit(who["ip"])
        await run_in_threadpool(
            logins.record, s.db_path, "sign_in_failed", verified=False, email=body.email.strip(), who=who,
            reason="wrong email or password",
        )
        raise HTTPException(status_code=401, detail="That email and password do not match.")
    limit.clear(who["ip"])
    token, expires = await run_in_threadpool(logins.open_session, s.db_path, s.admin_email, s.admin_password_hash)
    await run_in_threadpool(
        logins.record, s.db_path, "signed_in", verified=True, email=s.admin_email, who=who,
        session=logins.session_ref(token), expires_at=expires,
    )
    _cookie(request, response, token, logins.SESSION_HOURS * 3600)
    response.headers["Cache-Control"] = "no-store"
    return {"email": s.admin_email, "expires_at": expires}


@auth.post("/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    s = _settings(request)
    if not _same_origin(request):
        raise HTTPException(status_code=403, detail="not from this site")
    token = request.cookies.get(logins.COOKIE, "")
    live = logins.session(s.db_path, token, s.admin_email, s.admin_password_hash)
    if token:
        logins.close_session(s.db_path, token)
    if live:
        logins.record(s.db_path, "signed_out", verified=True, email=live["email"], who=_who(request),
                      session=logins.session_ref(token))
    response.delete_cookie(logins.COOKIE, path=logins.COOKIE_PATH)
    return {"ok": True}


def require_admin(request: Request, response: Response) -> dict[str, str]:
    """The session behind this request, or 401. Asked on every admin request:
    hiding the admin page is not what keeps strangers out."""
    s = _settings(request)
    live = logins.session(s.db_path, request.cookies.get(logins.COOKIE, ""), s.admin_email, s.admin_password_hash)
    if live is None:
        raise HTTPException(status_code=401, detail="Sign in to see this.")
    if request.method not in ("GET", "HEAD") and not _same_origin(request):
        raise HTTPException(status_code=403, detail="not from this site")
    response.headers["Cache-Control"] = "no-store"
    return live


Admin = Annotated[dict[str, str], Depends(require_admin)]
router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


@router.get("/me")
def me(admin: Admin, request: Request) -> dict[str, Any]:
    s = _settings(request)
    log = getattr(request.app.state, "traffic", None)
    return {**admin, "retention_days": s.log_retention_days, "traffic_log": bool(log and log.running),
            "traffic_problem": log.problem if log else None}


# ── The traffic report ───────────────────────────────────────────────────────


def _filter(
    period: str = "7d", who: str = "people", kind: str = "", status: str = "",
    ip: Annotated[str, Query(max_length=64)] = "", path: Annotated[str, Query(max_length=300)] = "",
    country: Annotated[str, Query(max_length=8)] = "", q: Annotated[str, Query(max_length=200)] = "",
) -> traffic.Filter:
    if period not in traffic.PERIODS:
        raise HTTPException(status_code=400, detail=f"period must be one of {', '.join(traffic.PERIODS)}")
    if who not in traffic.WHO:
        raise HTTPException(status_code=400, detail=f"who must be one of {', '.join(traffic.WHO)}")
    if kind and kind not in traffic.KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {', '.join(traffic.KINDS)}")
    if status and not re.fullmatch(r"[1-5](?:xx|\d\d)", status):
        raise HTTPException(status_code=400, detail="status is 2xx, 4xx, 404 and the like")
    return traffic.Filter(period, who, kind, status, ip.strip(), path, country.strip(), q)


Filtered = Annotated[traffic.Filter, Depends(_filter)]


def _traffic_db(request: Request) -> str:
    db = _settings(request).traffic_db
    if not db:
        raise HTTPException(status_code=404, detail="the traffic log is off (WIKIRACE_TRAFFIC_LOG=off)")
    log = getattr(request.app.state, "traffic", None)
    if log is not None:
        log.flush(1.0)
    return db


@router.get("/traffic")
def traffic_report(request: Request, f: Filtered) -> dict[str, Any]:
    return traffic.report(_traffic_db(request), f)


@router.get("/traffic/requests")
def traffic_requests(
    request: Request, f: Filtered,
    page: Annotated[int, Query(ge=1, le=100_000)] = 1, per: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    return traffic.requests(_traffic_db(request), f, page=page, per=per)


def csv_cell(value: Any) -> Any:
    """A cell a spreadsheet will show, never run: text that starts like a
    formula gets a leading apostrophe."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return "" if value is None else value


@router.get("/traffic/requests.csv")
def traffic_csv(request: Request, f: Filtered) -> StreamingResponse:
    db = _traffic_db(request)

    def lines() -> Iterator[str]:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id", *traffic.COLUMNS])
        for i, row in enumerate(traffic.export(db, f), 1):
            w.writerow([csv_cell(v) for v in row])
            if i % 500 == 0:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()

    name = f"traffic-{f.period}-{f.who}.csv"
    return StreamingResponse(lines(), media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store",
    })


# ── Sign-ins and what the admin did ──────────────────────────────────────────


@router.get("/signins")
def signins(
    request: Request, verified: str = "all",
    page: Annotated[int, Query(ge=1, le=100_000)] = 1, per: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    if verified not in ("all", "yes", "no"):
        raise HTTPException(status_code=400, detail="verified must be all, yes or no")
    return logins.signins(_settings(request).db_path, verified=verified, page=page, per=per)


@router.get("/audit")
def audit(request: Request, limit: Annotated[int, Query(ge=1, le=500)] = 50) -> dict[str, Any]:
    return {"rows": logins.audit_log(_settings(request).db_path, limit=limit)}


# ── Enquiries ────────────────────────────────────────────────────────────────


@router.get("/enquiries")
def enquiry_list(
    request: Request, status: str = "waiting",
    page: Annotated[int, Query(ge=1, le=100_000)] = 1, per: Annotated[int, Query(ge=1, le=100)] = 25,
) -> dict[str, Any]:
    if status not in enquiries.STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(enquiries.STATUSES)}")
    return enquiries.listing(_settings(request).db_path, status=status, page=page, per=per)


class HandledIn(BaseModel):
    handled: bool


@router.post("/enquiries/{enquiry_id}/handled")
def enquiry_handled(enquiry_id: int, body: HandledIn, request: Request, admin: Admin) -> dict[str, Any]:
    db = _settings(request).db_path
    if not enquiries.set_handled(db, enquiry_id, body.handled, admin["email"]):
        raise HTTPException(status_code=404, detail=f"no enquiry {enquiry_id}")
    logins.audit(db, admin["email"], "enquiry_handled" if body.handled else "enquiry_reopened", f"enquiry {enquiry_id}")
    return {"ok": True}


@router.delete("/enquiries/{enquiry_id}")
def enquiry_delete(enquiry_id: int, request: Request, admin: Admin) -> dict[str, Any]:
    db = _settings(request).db_path
    gone = enquiries.get(db, enquiry_id)
    if gone is None or not enquiries.delete(db, enquiry_id):
        raise HTTPException(status_code=404, detail=f"no enquiry {enquiry_id}")
    # Not who sent it: a deleted enquiry leaves no email behind.
    logins.audit(db, admin["email"], "enquiry_deleted", f"enquiry {enquiry_id}", f"sent {gone['created_at']}")
    return {"ok": True}
