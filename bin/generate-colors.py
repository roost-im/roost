#!/usr/bin/python

import json

# Code from Alan Huang
#
# TODO(davidben): I'm pretty sure @color{1}, and such also work in
# barnowl. Should fix that.
COLORS256 = {
    232 : '#080808',
    233 : '#121212',
    234 : '#1c1c1c',
    235 : '#262626',
    236 : '#303030',
    237 : '#3a3a3a',
    238 : '#444444',
    239 : '#4e4e4e',
    240 : '#585858',
    241 : '#626262',
    242 : '#6c6c6c',
    243 : '#767676',
    244 : '#808080',
    245 : '#8a8a8a',
    246 : '#949494',
    247 : '#9e9e9e',
    248 : '#a8a8a8',
    249 : '#b2b2b2',
    250 : '#bcbcbc',
    251 : '#c6c6c6',
    252 : '#d0d0d0',
    253 : '#dadada',
    254 : '#e4e4e4',
    255 : '#eeeeee',
}

for i in range(216):
    COLORS256[i + 16] = '#' + ''.join(map([ '00', '5f', '87', 'af', 'd7', 'ff' ].__getitem__, [ i / 36, i / 6 % 6, i % 6 ]))

print "var COLOR_MAP = "
print json.dumps(COLORS256) + ";"
