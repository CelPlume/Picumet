"""实验室语料：从真实目录挑选确定性样本（按需读取，不预复制）。

来源与口径：
  /mnt/d/res/gastigado   个人素材库：图片（jpg/png/webp/svg）、视频、中文与空格文件名
  /mnt/d/Archives/Video  视频归档：**只取中性缩略图（catch/pics）与其目录/命名结构**，
                         不含露骨媒体本体——存储链路测试不需要成人内容，避免无谓的合规风险
  /mnt/d/res/ISO         大文件（分片上传）样本
  <repo>/               源码与文档（代码预览、纯文本上传）

选择规则全部确定性：按路径排序后取前 N，附加大小上限，便于复现。
"""
from __future__ import annotations

import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
GASTIGADO = pathlib.Path('/mnt/d/res/gastigado')
ARCHIVES_VIDEO = pathlib.Path('/mnt/d/Archives/Video')
ISO_DIR = pathlib.Path('/mnt/d/res/ISO')

IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bmp'}
VIDEO_EXT = {'.mp4', '.webm', '.mov', '.mkv', '.avi'}
TEXT_EXT = {'.md', '.txt', '.json', '.yml', '.yaml', '.py', '.ts', '.tsx', '.js', '.css', '.html', '.log'}

# 基础套件用的小样本（体积小、类型覆盖全、含中文/空格文件名）
SMALL_SAMPLE_NAMES = [
    ('gastigado', 'background/3200x2000_1739375546912_41.png'),
    ('gastigado', 'background/aivax_walking_on_the_moon_864x1088_1739375550308_89.jpg'),
    ('gastigado', 'background/torres_del_paine_9625x4980_18001_副本_1739375553689_21.jpg'),
    ('gastigado', 'background/fluent_web_light_2_145a07dcb971527a82b8.svg'),
    ('gastigado', 'others/baoqi.mp4'),
    ('archives', 'Captures/catch/pics/2048 (10).jpg'),
]

# 大文件样本（用户指定：从 ISO 目录挑两三个）
ISO_SAMPLE_NAMES = [
    'WePE64_V2.2.iso',            # ≈226 MiB：刚跨过 100 MiB 分片阈值
    'FirPE-V1.9.1.iso',           # ≈888 MiB
    'Hikari_PE_X64_V9.0_R4_SC.iso',  # ≈968 MiB
]

_INVALID_NAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_name(name: str, *, fallback: str = 'item', max_len: int = 200) -> str:
    """把来源目录名收敛成项目允许的文件名（去掉非法字符、去首尾空白与点）。"""
    cleaned = _INVALID_NAME_CHARS.sub('_', name).strip().strip('.')
    return (cleaned or fallback)[:max_len]


def small_samples() -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for root_key, rel in SMALL_SAMPLE_NAMES:
        base = GASTIGADO if root_key == 'gastigado' else ARCHIVES_VIDEO
        path = base / rel
        out.append(path)
    out.append(REPO_ROOT / 'workers/src/index.ts')  # 代码预览
    missing = [str(p) for p in out if not p.is_file()]
    if missing:
        raise FileNotFoundError(f'基础语料缺失：{missing}')
    return out


def iso_samples() -> list[pathlib.Path]:
    out = [ISO_DIR / name for name in ISO_SAMPLE_NAMES]
    missing = [str(p) for p in out if not p.is_file()]
    if missing:
        raise FileNotFoundError(f'ISO 语料缺失：{missing}')
    return out


def all_iso_available() -> list[tuple[str, int]]:
    return sorted(((p.name, p.stat().st_size) for p in ISO_DIR.glob('*') if p.is_file()), key=lambda x: x[1])


def _walk(base: pathlib.Path, *, exts: set[str], max_files: int, max_file_bytes: int, max_total_bytes: int,
          skip_dirs: set[str]) -> list[pathlib.Path]:
    picked: list[pathlib.Path] = []
    total = 0
    for path in sorted(base.rglob('*')):
        if not path.is_file():
            continue
        if any(part in skip_dirs for part in path.relative_to(base).parts):
            continue
        if path.suffix.lower() not in exts:
            continue
        size = path.stat().st_size
        if size == 0 or size > max_file_bytes:
            continue
        if total + size > max_total_bytes:
            break
        picked.append(path)
        total += size
        if len(picked) >= max_files:
            break
    return picked


def gastigado_plan(*, max_files: int = 90, max_file_bytes: int = 40 * 1024 * 1024,
                   max_total_bytes: int = 700 * 1024 * 1024) -> list[pathlib.Path]:
    """gastigado 语料：图片/视频/网页资源，保留真实子目录层级。"""
    return _walk(
        GASTIGADO,
        exts=IMAGE_EXT | VIDEO_EXT | {'.svg', '.css', '.js', '.html'},
        max_files=max_files,
        max_file_bytes=max_file_bytes,
        max_total_bytes=max_total_bytes,
        skip_dirs={'.git'},
    )


def gastigado_videos(*, limit: int = 4, max_file_bytes: int = 60 * 1024 * 1024) -> list[pathlib.Path]:
    """gastigado 视频样本（体积可控，用于视频预览 / 首帧缩略图 / 播放器 poster 测试）。"""
    return _walk(
        GASTIGADO,
        exts=VIDEO_EXT,
        max_files=limit,
        max_file_bytes=max_file_bytes,
        max_total_bytes=200 * 1024 * 1024,
        skip_dirs={'.git'},
    )


def archive_plan(*, max_files: int = 60, max_file_bytes: int = 4 * 1024 * 1024,
                 max_total_bytes: int = 150 * 1024 * 1024) -> list[pathlib.Path]:
    """Archives/Video 语料：只用中性缩略图（catch/pics 等），保留其目录/命名结构。"""
    picked: list[pathlib.Path] = []
    for folder in ('Captures/catch/pics', 'Captures/x', 'Captures/MQ_neo'):
        base = ARCHIVES_VIDEO / folder
        if not base.is_dir():
            continue
        picked += _walk(
            base,
            exts=IMAGE_EXT,
            max_files=max(0, max_files - len(picked)),
            max_file_bytes=max_file_bytes,
            max_total_bytes=max_total_bytes,
            skip_dirs=set(),
        )
        if len(picked) >= max_files:
            break
    return picked


def repo_plan(*, max_files: int = 20) -> list[pathlib.Path]:
    """仓库内文本/源码样本（代码预览、纯文本上传路径）。"""
    candidates = [REPO_ROOT / 'AGENTS.md', REPO_ROOT / 'README_CN.md']
    candidates += sorted((REPO_ROOT / 'docs').glob('*.md'))
    candidates += sorted((REPO_ROOT / 'workers/src').rglob('*.ts'))
    out: list[pathlib.Path] = []
    for path in candidates:
        if path.is_file() and path.stat().st_size <= 400 * 1024:
            out.append(path)
        if len(out) >= max_files:
            break
    return out


def dest_dir_for(source: pathlib.Path, *, root: str, base: pathlib.Path | None = None) -> str:
    """把来源文件映射到目标目录：保留来源相对目录（逐段 sanitize）。"""
    if base is not None:
        try:
            rel = source.relative_to(base)
        except ValueError:
            rel = pathlib.Path(source.name)
    else:
        rel = pathlib.Path(source.name)
    parts = [sanitize_name(p) for p in rel.parent.parts if p not in ('', '.')]
    return '/'.join([root.rstrip('/')] + parts) or root
