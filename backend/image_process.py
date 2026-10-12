import sys, warnings, resource
resource.setrlimit(resource.RLIMIT_AS, (192*1024*1024, 192*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 8_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
with Image.open(sys.argv[1]) as original:
    if original.format not in ('JPEG', 'PNG', 'WEBP'):
        raise ValueError('unsupported image format')
    original.load()
    image = ImageOps.exif_transpose(original).convert('RGB')
    image.thumbnail((960, 960))
    image.save(sys.argv[2], 'WEBP', quality=82, method=6)
