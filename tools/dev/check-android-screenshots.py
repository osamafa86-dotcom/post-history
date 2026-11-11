"""فحص ملفات PNG الناتجة وأبعادها، بلا تعديل الصور أو بياناتها."""
from pathlib import Path
import struct
import sys


def validate(folder, size):
    expected = {f'{name}.png' for name in ('01-home', '02-materials', '03-new-material', '04-uploads', '05-notifications')}
    files = {p.name for p in Path(folder).glob('*.png')}
    if files != expected:
        raise ValueError('incomplete screenshot set')
    width, height = map(int, size.split('x'))
    for name in expected:
        with (Path(folder) / name).open('rb') as stream:
            header = stream.read(24)
        if len(header) != 24 or header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
            raise ValueError('invalid PNG header')
        if struct.unpack('>II', header[16:24]) != (width, height):
            raise ValueError('unexpected screenshot dimensions')


if __name__ == '__main__':
    validate(sys.argv[1], sys.argv[2])
